import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../../application/ports/command-runner.js';
import { NodeCommandRunner } from '../process/node-command-runner.js';
import { createFsPackRegistry } from './fs-pack-registry.js';

/**
 * bdboard-harness パックの hooks/ スクリプトの統合テスト (bdboard-pkr6.1)。
 *
 * hook は Claude Code から「bash で spawn し stdin に JSON を流す」形でしか
 * 呼ばれないので、テストも同じ形で叩く。ロジックを TypeScript に写して単体テスト
 * しても、実際に走るシェルの挙動 (bash 3.2 互換性・grep の方言・git の呼び出し) は
 * 何も保証されないため。
 *
 * Windows CI では skip する: 対象がそもそも POSIX シェルスクリプトで、bash・
 * coreutils・chmod による実行ビットが揃っている前提で書かれている。
 *
 * 実行ビットには依存せず `bash <script>` で呼ぶ (注入時の chmod は bdboard-pkr6.2)。
 */

const PACKS_ROOT = fileURLToPath(new URL('../../../harness/packs/', import.meta.url));
const HOOKS_DIR = path.join(PACKS_ROOT, 'bdboard-harness', 'hooks');

const STOP_TICKET_GATE = path.join(HOOKS_DIR, 'stop-ticket-gate.sh');
const ROUTE_SCRIPT = path.join(PACKS_ROOT, 'bdboard-harness', 'scripts', 'route.sh');

const runner = new NodeCommandRunner();

interface RunOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

async function runHook(
  script: string,
  payload: Record<string, unknown>,
  options?: RunOptions,
): Promise<CommandResult> {
  return runner.run('bash', [script], {
    input: JSON.stringify(payload),
    timeoutMs: 20_000,
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options?.env === undefined ? {} : { env: options.env }),
  });
}

describe.skipIf(process.platform === 'win32')('bdboard-harness pack hooks', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-pack-hooks-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('pack packaging', () => {
    it('enumerates hooks/ as injectable pack files', async () => {
      const registry = createFsPackRegistry(PACKS_ROOT);
      const pack = await registry.getPack('bdboard-harness');

      const relativePaths = (pack?.files ?? []).map((file) => file.relativePath);
      expect(relativePaths).toEqual(
        expect.arrayContaining([
          'hooks/README.md',
          'hooks/stop-ticket-gate.sh',
          'hooks/worktree-freshness.sh',
        ]),
      );
      // bdboard-cm2q.10 で削除した hook / script が個別に再混入しないことを守る。
      for (const removedPath of [
        'hooks/pre-bash-guard.sh',
        'hooks/pre-edit-guard.sh',
        'hooks/server-guard.sh',
        'hooks/worktree-owner-guard.sh',
        'hooks/lib-main-checkout.sh',
        'scripts/worktree-owner.sh',
      ]) {
        expect(relativePaths, removedPath).not.toContain(removedPath);
      }
    });

    /**
     * pack.json の hooks[] は P1b (bdboard-pkr6.2) が settings.json へ書き写す契約。
     * script が実在しない・注入ファイルに含まれない・timeout が抜けている、といった
     * 破れは P1b 側では気付けない (注入した後で hook が動かないだけ) のでここで守る。
     */
    it('declares hooks that point at injectable scripts with an event and a timeout', async () => {
      const manifest = JSON.parse(
        readFileSync(path.join(PACKS_ROOT, 'bdboard-harness', 'pack.json'), 'utf8'),
      ) as { readonly hooks?: ReadonlyArray<Record<string, unknown>> };

      const registry = createFsPackRegistry(PACKS_ROOT);
      const pack = await registry.getPack('bdboard-harness');
      const packFiles = (pack?.files ?? []).map((file) => file.relativePath);

      const hooks = manifest.hooks ?? [];
      expect(hooks.length).toBeGreaterThan(0);

      for (const hook of hooks) {
        expect(['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'UserPromptSubmit']).toContain(
          hook.event,
        );
        expect(typeof hook.script).toBe('string');

        const script = hook.script as string;
        expect(existsSync(path.join(PACKS_ROOT, 'bdboard-harness', script))).toBe(true);
        expect(packFiles).toContain(script);

        expect(Number.isInteger(hook.timeout)).toBe(true);
        expect(hook.timeout as number).toBeGreaterThan(0);
      }
    });
  });

  describe('scripts/route.sh (models.routes / models.exclude)', () => {
    const ROUTES = {
      implement: {
        low: ['codex:gpt-5.6-luna'],
        med: ['codex:gpt-5.6-terra', 'cursor:composer-2.5'],
        high: ['codex:gpt-5.6-sol'],
      },
    };

    let projectRoot: string;
    let env: Record<string, string>;

    beforeEach(async () => {
      projectRoot = path.join(tmpRoot, 'project');
      mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
      env = isolatedEnv();
      await initGitRepo(projectRoot, 'main', env);
    });

    function writeContract(contract: Record<string, unknown>): void {
      writeFileSync(
        path.join(projectRoot, '.claude', 'bdboard-harness.json'),
        JSON.stringify(contract) + '\n',
      );
    }

    /** route.sh をプロジェクトルートと隔離済み環境で直接叩く。 */
    async function runRoute(stage: string, complexity: string): Promise<CommandResult> {
      return runner.run('bash', [ROUTE_SCRIPT, stage, complexity], {
        cwd: projectRoot,
        env,
        timeoutMs: 20_000,
      });
    }

    /**
     * route.sh は scripts/aimix-run.sh が使う単一の候補リゾルバーである。
     * jq を優先し、無ければ python3 で読むため、両分岐を同じケースで検証する
     * (bdboard-p5l.20 / bdboard-p5l.22)。python3 分岐は jq を置かない専用 PATH
     * で強制し、不正な表を読ませたときの (via <tool>) で実際の分岐も確認する。
     */
    // jq 側は通常の PATH で走らせる。jq が無ければ黙って python3 へ縮退させず、
    // 下の (via jq) の番人テストで必須依存として検出する。
    for (const jsonTool of ['jq', 'python3']) {
      describe('models.exclude (bdboard-p5l.20 / p5l.22) via ' + jsonTool, () => {
        beforeEach(async () => {
          if (jsonTool === 'python3') {
            env = await noJqEnv();
          }
        });

        it('route.sh actually resolves through ' + jsonTool, async () => {
          writeContract({ mainBranch: 'main', models: { routes: { implement: { high: [] } } } });

          const result = await runRoute('implement', 'high');

          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe('');
          expect(result.stderr).toContain('(via ' + jsonTool + ')');
        });

        it('route.sh drops an actively-excluded member from the candidates', async () => {
          writeContract({
            mainBranch: 'main',
            models: {
              routes: ROUTES,
              exclude: [
                { member: 'cursor', until: '2999-01-01', reason: 'レートリミット逼迫' },
              ],
            },
          });

          const result = await runRoute('implement', 'med');

          expect(result.exitCode).toBe(0);
          const lines = result.stdout.trim().split('\n').filter(Boolean);
          expect(lines).toContain('codex:gpt-5.6-terra');
          expect(lines).not.toContain('cursor:composer-2.5');
        });

        it('an expired exclude is ignored by route.sh', async () => {
          writeContract({
            mainBranch: 'main',
            models: {
              routes: ROUTES,
              exclude: [{ member: 'cursor', until: '2000-01-01', reason: '期限切れ' }],
            },
          });

          const result = await runRoute('implement', 'med');

          expect(result.exitCode).toBe(0);
          expect(result.stdout.trim().split('\n').filter(Boolean)).toContain(
            'cursor:composer-2.5',
          );
        });

        /**
         * bdboard-p5l.22: 除外で候補が 0 件になったセル。通常出力は空になり、
         * --excluded はそのセルで有効な除外 member を宣言順・重複なしで返す。
         */
        describe('a cell emptied by exclusion', () => {
          const EXCLUDE = [
            { member: 'codex', until: '2999-01-01', reason: '枠逼迫' },
            // 同じ member の重複 entry と、セルに居ない member。
            { member: 'codex', until: '2999-02-01' },
            { member: 'gemini', until: '2999-01-01' },
            // 期限切れ・壊れた entry は --excluded にも出ない。
            { member: 'cursor', until: '2000-01-01' },
            { member: 42, until: '2999-01-01' },
            // member 形式に合わない entry (改行入りで別名に化けうるものを含む) も無視。
            { member: 'bad\ncursor', until: '2999-01-01' },
            { member: 'Codex', until: '2999-01-01' },
            'not-an-object',
          ];

          beforeEach(() => {
            writeContract({ mainBranch: 'main', models: { routes: ROUTES, exclude: EXCLUDE } });
          });

          it('route.sh prints nothing, and --excluded lists the active excluded members', async () => {
            const routeResult = await runRoute('implement', 'high');
            expect(routeResult.exitCode).toBe(0);
            expect(routeResult.stdout).toBe('');

            const excluded = await runner.run(
              'bash',
              [ROUTE_SCRIPT, '--excluded', 'implement', 'high'],
              { cwd: projectRoot, env, timeoutMs: 20_000 },
            );
            expect(excluded.exitCode).toBe(0);
            expect(excluded.stdout).toBe('codex\ngemini\n');
          });
        });

        it('an undeclared cell stays "no opinion" for --excluded', async () => {
          writeContract({
            mainBranch: 'main',
            models: {
              routes: { review: ROUTES.implement },
              exclude: [{ member: 'codex', until: '2999-01-01' }],
            },
          });

          const excluded = await runner.run(
            'bash',
            [ROUTE_SCRIPT, '--excluded', 'implement', 'high'],
            { cwd: projectRoot, env, timeoutMs: 20_000 },
          );

          expect(excluded.exitCode).toBe(0);
          expect(excluded.stdout).toBe('');
        });

        it('an expired exclude on a single-candidate cell does not empty it', async () => {
          writeContract({
            mainBranch: 'main',
            models: {
              routes: ROUTES,
              exclude: [{ member: 'codex', until: '2000-01-01' }],
            },
          });

          const excluded = await runner.run(
            'bash',
            [ROUTE_SCRIPT, '--excluded', 'implement', 'high'],
            { cwd: projectRoot, env, timeoutMs: 20_000 },
          );

          expect(excluded.exitCode).toBe(0);
          expect(excluded.stdout).toBe('');
        });

        it('route.sh --excluded validates its arguments like the default mode', async () => {
          writeContract({ mainBranch: 'main', models: { routes: ROUTES } });

          for (const args of [
            ['--excluded', 'implement', 'bogus'],
            ['--excluded', 'implement'],
            ['implement', 'high', '--excluded'],
          ]) {
            const result = await runner.run('bash', [ROUTE_SCRIPT, ...args], {
              cwd: projectRoot,
              env,
              timeoutMs: 20_000,
            });
            expect(result.exitCode).toBe(2);
            expect(result.stdout).toBe('');
          }
        });
      });
    }
  });

  describe('stop-ticket-gate.sh', () => {
    /**
     * Stop hook は bd を叩くので、PATH の先頭に固定 JSON を返す fake bd を置いた
     * 一時ディレクトリを差し込む。実際の .beads/ を読ませないため。
     */
    /**
     * fake bd。`show` は id が 'test-1' のときだけ成功する (どの id でも成功させると、
     * worktree 名フォールバックの id 推定ロジック自体が壊れても気付けないため —
     * bdboard-pkr6.25 レビュー指摘)。全テストのチケット id は 'test-1' に統一している。
     */
    function fakeBdScriptSource(comments: string, argsLog: string): string {
      return [
        '#!/bin/sh',
        `echo "$*" >> '${argsLog}'`,
        '# hook は必ず -C <cwd> を先頭に付けて呼ぶ。本物と同じくそれを取り除いて解釈する。',
        'if [ "${1:-}" = "-C" ]; then',
        '  shift 2',
        'fi',
        'case "${1:-}" in',
        '  show)',
        `    if [ "\${2:-}" != 'test-1' ]; then exit 1; fi`,
        `    cat <<'BD_SHOW_EOF'`,
        JSON.stringify([{ id: 'test-1', status: 'in_progress' }]),
        'BD_SHOW_EOF',
        '    ;;',
        `  comments) cat <<'BD_COMMENTS_EOF'`,
        comments,
        'BD_COMMENTS_EOF',
        '    ;;',
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n');
    }

    function writeFakeBd(binDir: string, comments: string, argsLog: string): void {
      mkdirSync(binDir, { recursive: true });
      const fakeBd = path.join(binDir, 'bd');
      writeFileSync(fakeBd, fakeBdScriptSource(comments, argsLog), 'utf8');
      chmodSync(fakeBd, 0o755);
    }

    /**
     * PATH から実行ファイルを探して binDir へ symlink する (noJqEnv と同じ方式)。
     */
    function symlinkFromPath(binDir: string, names: readonly string[]): void {
      const searchDirs = (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter);
      for (const name of names) {
        const target = searchDirs
          .map((dir) => path.join(dir, name))
          .find((candidate) => {
            try {
              accessSync(candidate, fsConstants.X_OK);
              return true;
            } catch {
              return false;
            }
          });
        if (target === undefined) {
          throw new Error(`symlinkFromPath: required command not found on PATH: ${name}`);
        }
        symlinkSync(target, path.join(binDir, name));
      }
    }

    /**
     * jq 経路は isolatedEnv (実 PATH + fake bd 前置) をそのまま使う。python3 経路は
     * noJqEnv の隔離 PATH (jq を引けない) に、stop-ticket-gate.sh が追加で使う wc/cut と
     * fake bd を同じ binDir へ足して作る (bdboard-pkr6.25: 4分岐を両経路で固定するため)。
     */
    async function setupJsonTool(
      jsonTool: 'jq' | 'python3',
      comments: string,
    ): Promise<{ env: Record<string, string>; argsLog: string }> {
      const argsLog = path.join(tmpRoot, 'bd-args.log');
      if (jsonTool === 'python3') {
        const env = await noJqEnv();
        symlinkFromPath(env.PATH, ['wc', 'cut']);
        writeFakeBd(env.PATH, comments, argsLog);
        return { env, argsLog };
      }
      const binDir = path.join(tmpRoot, 'bin');
      writeFakeBd(binDir, comments, argsLog);
      return { env: isolatedEnv(binDir), argsLog };
    }

    async function setupTicketWorktree(options: {
      readonly branch: string;
      readonly comments: string;
      readonly dirty: boolean;
      /** 既定は tmpRoot/repo。worktree 名フォールバックの検証など、パスそのものを
       *  試験対象にしたいときだけ上書きする。 */
      readonly repoDir?: string;
      /** 既定は 'jq'。 */
      readonly jsonTool?: 'jq' | 'python3';
    }): Promise<{ repo: string; env: Record<string, string>; argsLog: string }> {
      const { env, argsLog } = await setupJsonTool(options.jsonTool ?? 'jq', options.comments);

      const repo = options.repoDir ?? path.join(tmpRoot, 'repo');
      await initGitRepo(repo, options.branch, env);
      if (options.dirty) {
        writeFileSync(path.join(repo, 'dirty.txt'), 'wip\n', 'utf8');
      }

      return { repo, env, argsLog };
    }

    /**
     * origin リモートを bare repo として用意し、現在の HEAD を <mainBranchName> へ
     * push + fetch する (ローカルの origin/<mainBranchName> 追跡参照を作るため)。
     */
    async function addOriginRemote(
      repo: string,
      env: Record<string, string>,
      mainBranchName: string,
    ): Promise<void> {
      const bare = path.join(tmpRoot, `origin-${mainBranchName}.git`);
      await runGit(tmpRoot, ['init', '-q', '--bare', bare], env);
      await runGit(repo, ['remote', 'add', 'origin', bare], env);
      await runGit(repo, ['push', '-q', 'origin', `HEAD:refs/heads/${mainBranchName}`], env);
      await runGit(repo, ['fetch', '-q', 'origin'], env);
    }

    /**
     * 既に書き出し済みのファイルを add + commit する (中身は書き換えない)。
     */
    async function commitPath(
      repo: string,
      env: Record<string, string>,
      relPath: string,
    ): Promise<void> {
      await runGit(repo, ['add', relPath], env);
      await runGit(
        repo,
        [
          '-c',
          'user.name=bdboard-test',
          '-c',
          'user.email=bdboard-test@example.invalid',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-q',
          '-m',
          `commit: ${relPath}`,
        ],
        env,
      );
    }

    /**
     * ファイルを1つ追加してコミットする。呼び出し前に working tree が clean なら、
     * 呼び出し後も clean なまま HEAD だけ 1 コミット進む。
     */
    async function commitExtra(
      repo: string,
      env: Record<string, string>,
      fileName: string,
    ): Promise<void> {
      writeFileSync(path.join(repo, fileName), 'extra\n', 'utf8');
      await commitPath(repo, env, fileName);
    }

    it('passes when the branch is not a per-ticket branch', async () => {
      const { repo, env } = await setupTicketWorktree({
        branch: 'main',
        comments: '[]',
        dirty: true,
      });

      const result = await runHook(
        STOP_TICKET_GATE,
        { hook_event_name: 'Stop', cwd: repo },
        { cwd: repo, env },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('passes when stop_hook_active is true', async () => {
      const { repo, env } = await setupTicketWorktree({
        branch: 'bd/test-1',
        comments: '[]',
        dirty: true,
      });

      const result = await runHook(
        STOP_TICKET_GATE,
        { hook_event_name: 'Stop', cwd: repo, stop_hook_active: true },
        { cwd: repo, env },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('passes when a PR comment already exists', async () => {
      const { repo, env } = await setupTicketWorktree({
        branch: 'bd/test-1',
        comments: JSON.stringify([
          { text: 'PR: https://example.invalid/pull/1', created_at: '2020-01-01T00:00:00Z' },
        ]),
        dirty: true,
      });

      const result = await runHook(
        STOP_TICKET_GATE,
        { hook_event_name: 'Stop', cwd: repo },
        { cwd: repo, env },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('blocks an in_progress ticket with uncommitted work and no trace', async () => {
      const { repo, env, argsLog } = await setupTicketWorktree({
        branch: 'bd/test-1',
        comments: '[]',
        dirty: true,
      });

      const result = await runHook(
        STOP_TICKET_GATE,
        { hook_event_name: 'Stop', cwd: repo },
        { cwd: repo, env },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('test-1');
      expect(result.stderr).toContain('in_progress');
      expect(result.stderr.trim().split('\n').length).toBeLessThanOrEqual(3);

      // bd は hook の cwd を明示して呼ぶ (別チェックアウトの .beads/ を読まないため)。
      const bdCalls = readFileSync(argsLog, 'utf8').trim().split('\n');
      expect(bdCalls.length).toBeGreaterThan(0);
      for (const call of bdCalls) {
        expect(call.startsWith(`-C ${repo} `)).toBe(true);
      }
    });

    it('passes when the working tree is clean', async () => {
      const { repo, env } = await setupTicketWorktree({
        branch: 'bd/test-1',
        comments: '[]',
        dirty: false,
      });

      const result = await runHook(
        STOP_TICKET_GATE,
        { hook_event_name: 'Stop', cwd: repo },
        { cwd: repo, env },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('passes when the latest comment is within 4 hours', async () => {
      // bd の created_at は秒精度の UTC。ミリ秒を落として同じ形にそろえる。
      const recent = new Date(Date.now() - 2 * 60 * 60_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      const { repo, env } = await setupTicketWorktree({
        branch: 'bd/test-1',
        comments: JSON.stringify([{ text: '作業中断: 残りは X', created_at: recent }]),
        dirty: true,
      });

      const result = await runHook(
        STOP_TICKET_GATE,
        { hook_event_name: 'Stop', cwd: repo },
        { cwd: repo, env },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('blocks when the latest comment is older than 4 hours', async () => {
      // bd の created_at は秒精度の UTC。ミリ秒を落として同じ形にそろえる。
      const stale = new Date(Date.now() - 5 * 60 * 60_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      const { repo, env } = await setupTicketWorktree({
        branch: 'bd/test-1',
        comments: JSON.stringify([{ text: '作業中断: 残りは X', created_at: stale }]),
        dirty: true,
      });

      const result = await runHook(
        STOP_TICKET_GATE,
        { hook_event_name: 'Stop', cwd: repo },
        { cwd: repo, env },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('直近4時間のコメント');
    });

    for (const jsonTool of ['jq', 'python3'] as const) {
      it(`blocks only once per session via ${jsonTool}`, async () => {
        const { repo, env } = await setupTicketWorktree({
          branch: 'bd/test-1',
          comments: '[]',
          dirty: true,
          jsonTool,
        });
        const markerTmp = path.join(tmpRoot, `tmp-${jsonTool}`);
        mkdirSync(markerTmp, { recursive: true });
        env.TMPDIR = markerTmp;
        if (jsonTool === 'python3') {
          symlinkFromPath(env.PATH, ['mkdir']);
        }
        const payload = {
          hook_event_name: 'Stop',
          cwd: repo,
          session_id: 'sess-a',
        };

        const first = await runHook(STOP_TICKET_GATE, payload, { cwd: repo, env });
        const second = await runHook(STOP_TICKET_GATE, payload, { cwd: repo, env });

        expect(first.exitCode).toBe(2);
        expect(second.exitCode).toBe(0);
        expect(second.stderr).toBe('');
        expect(
          existsSync(path.join(markerTmp, 'bdboard-stop-ticket-gate', 'sess-a')),
        ).toBe(true);
      });
    }

    it('blocks again for a different session id', async () => {
      const { repo, env } = await setupTicketWorktree({
        branch: 'bd/test-1',
        comments: '[]',
        dirty: true,
      });
      const markerTmp = path.join(tmpRoot, 'tmp');
      mkdirSync(markerTmp, { recursive: true });
      env.TMPDIR = markerTmp;

      const first = await runHook(
        STOP_TICKET_GATE,
        { hook_event_name: 'Stop', cwd: repo, session_id: 'sess-a' },
        { cwd: repo, env },
      );
      const second = await runHook(
        STOP_TICKET_GATE,
        { hook_event_name: 'Stop', cwd: repo, session_id: 'sess-b' },
        { cwd: repo, env },
      );

      expect(first.exitCode).toBe(2);
      expect(second.exitCode).toBe(2);
    });

    it('blocks every time when the sanitized session id is empty', async () => {
      const { repo, env } = await setupTicketWorktree({
        branch: 'bd/test-1',
        comments: '[]',
        dirty: true,
      });
      const markerTmp = path.join(tmpRoot, 'tmp');
      mkdirSync(markerTmp, { recursive: true });
      env.TMPDIR = markerTmp;
      const payload = {
        hook_event_name: 'Stop',
        cwd: repo,
        session_id: '../...',
      };

      const first = await runHook(STOP_TICKET_GATE, payload, { cwd: repo, env });
      const second = await runHook(STOP_TICKET_GATE, payload, { cwd: repo, env });

      expect(first.exitCode).toBe(2);
      expect(second.exitCode).toBe(2);
      expect(existsSync(path.join(markerTmp, 'bdboard-stop-ticket-gate'))).toBe(false);
    });

    /**
     * bdboard-pkr6.25: それまで未テストだった4分岐を jq / python3 の両経路で固定する。
     * (a) 作業ツリーはクリーンだが origin/<mainBranch>..HEAD にコミットがありブロックされる
     * (b) ブランチが bd/* でないとき .claude/worktrees/<name> からチケット ID を推定する
     *     フォールバック
     * (c) 検証コントラクトの mainBranch (例 master) 解決
     * (d) origin/<mainBranch> が無いときの skip
     */
    for (const jsonTool of ['jq', 'python3'] as const) {
      describe(`4 untested branches via ${jsonTool}`, () => {
        it('(a) blocks a clean tree when HEAD has commits not yet merged into main', async () => {
          const { repo, env } = await setupTicketWorktree({
            branch: 'bd/test-1',
            comments: '[]',
            dirty: false,
            jsonTool,
          });
          await addOriginRemote(repo, env, 'main');
          await commitExtra(repo, env, 'unmerged.txt');

          const result = await runHook(
            STOP_TICKET_GATE,
            { hook_event_name: 'Stop', cwd: repo },
            { cwd: repo, env },
          );

          expect(result.exitCode).toBe(2);
          expect(result.stderr).toContain('未コミット差分: 0 ファイル');
          expect(result.stderr).toContain('main 未取り込みのコミット: 1 件');
        });

        it('(b) derives the ticket id from the worktree path when the branch is not bd/*', async () => {
          const worktreeRepo = path.join(tmpRoot, '.claude', 'worktrees', 'test-1');
          const { repo, env, argsLog } = await setupTicketWorktree({
            branch: 'feature/not-a-ticket-branch',
            comments: '[]',
            dirty: true,
            repoDir: worktreeRepo,
            jsonTool,
          });

          const result = await runHook(
            STOP_TICKET_GATE,
            { hook_event_name: 'Stop', cwd: repo },
            { cwd: repo, env },
          );

          expect(result.exitCode).toBe(2);
          expect(result.stderr).toContain('test-1');

          // 推定した ticket id (worktree ディレクトリ名) で bd show が呼ばれていること。fake
          // bd は id が 'test-1' のときだけ成功するので、推定した名前が違えばここで失敗する。
          const bdCalls = readFileSync(argsLog, 'utf8').trim().split('\n');
          expect(bdCalls.some((call) => call.startsWith(`-C ${repo} show test-1`))).toBe(true);
        });

        it('(b-negative) does not fall back to an unrelated worktree directory name', async () => {
          // fake bd の show は 'test-1' 以外を拒否する。推定した id がそれと違えば
          // (= フォールバック条件「bd show が成功したときだけ採用」が効いていれば)
          // per-ticket worktree ではないのと同じ exit 0 になるはず。
          const worktreeRepo = path.join(tmpRoot, '.claude', 'worktrees', 'not-a-ticket');
          const { repo, env, argsLog } = await setupTicketWorktree({
            branch: 'feature/not-a-ticket-branch',
            comments: '[]',
            dirty: true,
            repoDir: worktreeRepo,
            jsonTool,
          });

          const result = await runHook(
            STOP_TICKET_GATE,
            { hook_event_name: 'Stop', cwd: repo },
            { cwd: repo, env },
          );

          expect(result.exitCode).toBe(0);
          expect(result.stderr).toBe('');

          // show は試みるが失敗し、以降 (comments 等) には進まない。
          const bdCalls = readFileSync(argsLog, 'utf8').trim().split('\n');
          expect(bdCalls.some((call) => call.startsWith(`-C ${repo} show not-a-ticket`))).toBe(
            true,
          );
          expect(bdCalls.some((call) => call.includes(' comments '))).toBe(false);
        });

        it('(c) resolves mainBranch from the verification contract', async () => {
          const { repo, env } = await setupTicketWorktree({
            branch: 'bd/test-1',
            comments: '[]',
            dirty: false,
            jsonTool,
          });
          mkdirSync(path.join(repo, '.claude'), { recursive: true });
          writeFileSync(
            path.join(repo, '.claude', 'bdboard-harness.json'),
            `${JSON.stringify({ mainBranch: 'master' })}\n`,
            'utf8',
          );
          // コントラクト自体を未コミットのまま残すと DIRTY_COUNT が動いてしまい、
          // 「クリーンな作業ツリーでも mainBranch 解決経由でブロックする」ことの
          // 検証にならない。commit してから origin を積む。
          await commitPath(repo, env, path.join('.claude', 'bdboard-harness.json'));
          await addOriginRemote(repo, env, 'master');
          await commitExtra(repo, env, 'unmerged.txt');

          const result = await runHook(
            STOP_TICKET_GATE,
            { hook_event_name: 'Stop', cwd: repo },
            { cwd: repo, env },
          );

          expect(result.exitCode).toBe(2);
          expect(result.stderr).toContain('未コミット差分: 0 ファイル');
          expect(result.stderr).toContain('master 未取り込みのコミット: 1 件');
        });

        it('(d) skips the unmerged-commit check when origin/<mainBranch> does not exist', async () => {
          const { repo, env, argsLog } = await setupTicketWorktree({
            branch: 'bd/test-1',
            comments: '[]',
            dirty: false,
            jsonTool,
          });
          // origin は一度も設定しない。ローカルにだけ余分なコミットを積んでも、
          // 比較対象の origin/main が無いので判定は skip され、通過するはず。
          await commitExtra(repo, env, 'local-only.txt');

          const result = await runHook(
            STOP_TICKET_GATE,
            { hook_event_name: 'Stop', cwd: repo },
            { cwd: repo, env },
          );

          expect(result.exitCode).toBe(0);
          expect(result.stderr).toBe('');

          // 早期リターン (ticket id 不明・status 判定漏れ等) ではなく、実際に
          // 手順4 (comments 参照) まで進んだ上で手順5の判定が skip されたことを確かめる。
          const bdCalls = readFileSync(argsLog, 'utf8').trim().split('\n');
          expect(bdCalls.some((call) => call.includes(' comments '))).toBe(true);
        });
      });
    }
  });

  /**
   * 子プロセスの環境を最小限に固定する。NodeCommandRunner の `env` は継承ではなく
   * 置き換えなので、PATH と HOME だけを与えてユーザーの global gitconfig や
   * 実物の bd を巻き込まないようにする。
   */
  function isolatedEnv(pathPrefix?: string): Record<string, string> {
    const home = path.join(tmpRoot, 'home');
    mkdirSync(home, { recursive: true });
    const basePath = process.env.PATH ?? '/usr/bin:/bin';
    return {
      PATH: pathPrefix === undefined ? basePath : `${pathPrefix}${path.delimiter}${basePath}`,
      HOME: home,
    };
  }

  /**
   * jq を引けず python3 だけを引ける PATH を作る (route.sh の python3 分岐を強制する。
   * bdboard-p5l.22)。専用ディレクトリへの symlink だけで PATH を組む。PATH から jq の
   * 在るディレクトリを抜く方式だと、macOS では /usr/bin/jq が
   * 標準で在るため /usr/bin ごと抜けてしまい、他の必須コマンドまで消える。python3 は
   * 実体 (sys.executable) へ張る。pyenv の shim は痩せた PATH では動かないため。
   */
  async function noJqEnv(): Promise<Record<string, string>> {
    const binDir = path.join(tmpRoot, 'no-jq-bin');
    mkdirSync(binDir, { recursive: true });
    const searchDirs = (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter);

    for (const name of ['bash', 'cat', 'grep', 'sed', 'tr', 'git', 'date', 'dirname']) {
      const target = searchDirs
        .map((dir) => path.join(dir, name))
        .find((candidate) => {
          try {
            accessSync(candidate, fsConstants.X_OK);
            return true;
          } catch {
            return false;
          }
        });
      if (target === undefined) {
        throw new Error(`noJqEnv: required command not found on PATH: ${name}`);
      }
      symlinkSync(target, path.join(binDir, name));
    }

    // 実体の解決も NodeCommandRunner 経由で行う (テストから child_process を直接
    // import しない — check:boundaries の no-child-process-outside-process-runners)。
    const pythonProbe = await runner.run('python3', ['-c', 'import sys; print(sys.executable)'], {
      timeoutMs: 20_000,
    });
    const python = pythonProbe.stdout.trim();
    if (pythonProbe.exitCode !== 0 || python === '') {
      throw new Error(`noJqEnv: cannot resolve the python3 interpreter: ${pythonProbe.stderr}`);
    }
    symlinkSync(python, path.join(binDir, 'python3'));

    const home = path.join(tmpRoot, 'home');
    mkdirSync(home, { recursive: true });
    return { PATH: binDir, HOME: home };
  }

  async function initGitRepo(
    repoPath: string,
    branch: string,
    env: Record<string, string>,
  ): Promise<void> {
    mkdirSync(repoPath, { recursive: true });
    await runGit(repoPath, ['init', '-q'], env);
    await runGit(repoPath, ['checkout', '-q', '-b', branch], env);
    await runGit(
      repoPath,
      [
        '-c',
        'user.name=bdboard-test',
        '-c',
        'user.email=bdboard-test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      env,
    );
  }

  async function runGit(
    cwd: string,
    args: readonly string[],
    env: Record<string, string>,
  ): Promise<void> {
    const result = await runner.run('git', args, { cwd, env, timeoutMs: 20_000 });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr}`);
    }
  }
});
