import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandResult } from '../../application/ports/command-runner.js';
import { NodeCommandRunner } from '../process/node-command-runner.js';

/**
 * bdboard-harness パックの main checkout 保護の統合テスト (bdboard-kxqb)。
 *
 * 議長を main checkout (worktree ではなく本体) で動かす運用に切り替えたことに伴い、
 * サブエージェントが main checkout の working tree/HEAD を直接壊せないよう 2 箇所を追加した:
 *
 *   - pre-bash-guard.sh 規則 8 (本体 hooks/server-guard.sh): サブエージェントによる
 *     main checkout 対象の git checkout/switch/commit/reset/merge/rebase/stash/restore/
 *     cherry-pick/revert/am/clean/bisect/apply/rm/mv を deny。alwaysOnServer.port の有無に
 *     関係なく常時有効 (規則 7 とは独立)。pull は規則 8 に**含まない** — 既存の規則 7a
 *     (alwaysOnServer.port が要る) だけが引き続き担当する (二重化しない。下の
 *     MUTATING_FORMS の pull エントリは 7a 経由で deny されることの確認であって、
 *     規則 8 自身の対象ではない — 詳細は hooks/README.md「pull を対象外にした理由」)。
 *   - pre-edit-guard.sh 規則 2: 同じ main checkout 判定 (hooks/lib-main-checkout.sh を
 *     server-guard.sh と共有) で、サブエージェントによる main checkout 配下への
 *     Edit/Write/MultiEdit/NotebookEdit を deny。
 *
 * どちらも議長 (agent_id 無し) は対象外、`.claude/worktrees/<id>/...` (実在する worktree)
 * は対象外。
 *
 * 本物のメインチェックアウトには一切触れない。tmp に main + worktree の組を作り、
 * pack-hooks-server-guard.test.ts と同じ流儀で `.claude/bdboard-harness.json` を
 * `git worktree add` より前にコミットする — worktree からのチェックアウトはコミット時点の
 * ツリーを引き継ぐため、後から untracked で置いた契約ファイルは worktree からは見えず
 * (REPO_ROOT は worktree 自身の toplevel に解決される)、pre-bash-guard.sh の
 * `[ -r "$CONTRACT_FILE" ] || exit 0` に短絡してしまう。
 *
 * pack-hooks.test.ts と同じく Windows では skip (POSIX シェル前提)。
 */

const PACKS_ROOT = fileURLToPath(new URL('../../../harness/packs/', import.meta.url));
const PRE_BASH_GUARD = path.join(PACKS_ROOT, 'bdboard-harness', 'hooks', 'pre-bash-guard.sh');
const PRE_EDIT_GUARD = path.join(PACKS_ROOT, 'bdboard-harness', 'hooks', 'pre-edit-guard.sh');

const runner = new NodeCommandRunner();

const GIT_IDENTITY = [
  '-c',
  'user.name=bdboard-test',
  '-c',
  'user.email=bdboard-test@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

describe.skipIf(process.platform === 'win32')('bdboard-harness main checkout guard (bdboard-kxqb)', () => {
  let tmpRoot: string;
  let env: Record<string, string>;

  // 契約に alwaysOnServer.port があるペア (規則 8 が規則 7 と共存することの確認にも使う)。
  let mainWithPort: string;
  let worktreeWithPort: string;

  // 契約はあるが alwaysOnServer 自体が無いペア (規則 8 が port 非依存で効くことの確認)。
  let mainNoPort: string;
  let worktreeNoPort: string;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-main-checkout-guard-'));
    const home = path.join(tmpRoot, 'home');
    mkdirSync(home, { recursive: true });
    env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      TMPDIR: tmpRoot,
    };

    mainWithPort = path.join(tmpRoot, 'main-port');
    worktreeWithPort = path.join(tmpRoot, 'wt-port');
    await initGitRepo(mainWithPort, 'main');
    writeContract(mainWithPort, {
      version: 1,
      alwaysOnServer: { port: 18790, restartScript: 'scripts/always-on-server.sh' },
    });
    await runGit(mainWithPort, ['add', '.claude']);
    await runGit(mainWithPort, [...GIT_IDENTITY, 'commit', '-q', '-m', 'contract']);
    await runGit(mainWithPort, ['worktree', 'add', '-q', worktreeWithPort, '-b', 'bd/wt-port']);

    mainNoPort = path.join(tmpRoot, 'main-noport');
    worktreeNoPort = path.join(tmpRoot, 'wt-noport');
    await initGitRepo(mainNoPort, 'main');
    writeContract(mainNoPort, { version: 1 });
    await runGit(mainNoPort, ['add', '.claude']);
    await runGit(mainNoPort, [...GIT_IDENTITY, 'commit', '-q', '-m', 'contract']);
    await runGit(mainNoPort, ['worktree', 'add', '-q', worktreeNoPort, '-b', 'bd/wt-noport']);
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeContract(repoPath: string, contract: Record<string, unknown>): void {
    mkdirSync(path.join(repoPath, '.claude'), { recursive: true });
    writeFileSync(path.join(repoPath, '.claude', 'bdboard-harness.json'), JSON.stringify(contract));
  }

  async function runGit(cwd: string, args: readonly string[]): Promise<void> {
    const result = await runner.run('git', args, { cwd, env, timeoutMs: 20_000 });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr}`);
    }
  }

  async function initGitRepo(repoPath: string, branch: string): Promise<void> {
    mkdirSync(repoPath, { recursive: true });
    await runGit(repoPath, ['init', '-q']);
    await runGit(repoPath, ['checkout', '-q', '-b', branch]);
    await runGit(repoPath, [...GIT_IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'init']);
  }

  interface BashHookCall {
    readonly command: string;
    readonly cwd: string;
    /** 省略 = トップレベル (議長)。文字列 = サブエージェント。 */
    readonly agentId?: string;
  }

  async function runBashHook(call: BashHookCall): Promise<CommandResult> {
    const payload: Record<string, unknown> = {
      tool_name: 'Bash',
      tool_input: { command: call.command },
      cwd: call.cwd,
    };
    if (call.agentId !== undefined) {
      payload.agent_id = call.agentId;
    }
    return runner.run('bash', [PRE_BASH_GUARD], {
      input: JSON.stringify(payload),
      cwd: call.cwd,
      env,
      timeoutMs: 20_000,
    });
  }

  interface EditHookCall {
    readonly toolName: 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit';
    readonly filePath?: string;
    readonly notebookPath?: string;
    readonly cwd: string;
    readonly agentId?: string;
  }

  async function runEditHook(call: EditHookCall): Promise<CommandResult> {
    const toolInput: Record<string, unknown> = {};
    if (call.filePath !== undefined) {
      toolInput.file_path = call.filePath;
    }
    if (call.notebookPath !== undefined) {
      toolInput.notebook_path = call.notebookPath;
    }
    const payload: Record<string, unknown> = {
      tool_name: call.toolName,
      tool_input: toolInput,
      cwd: call.cwd,
    };
    if (call.agentId !== undefined) {
      payload.agent_id = call.agentId;
    }
    return runner.run('bash', [PRE_EDIT_GUARD], {
      input: JSON.stringify(payload),
      cwd: call.cwd,
      env,
      timeoutMs: 20_000,
    });
  }

  function expectDeny(result: CommandResult, ...fragments: readonly string[]): void {
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    const lines = result.stderr.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toMatch(/^bdboard-harness: /);
    for (const fragment of fragments) {
      expect(result.stderr).toContain(fragment);
    }
  }

  function expectAllow(result: CommandResult): void {
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  }

  describe('server-guard.sh rule 8 — Bash', () => {
    const MUTATING_FORMS: ReadonlyArray<{ readonly label: string; readonly command: string }> = [
      { label: 'checkout', command: 'git checkout other' },
      { label: 'switch', command: 'git switch other' },
      { label: 'commit', command: 'git commit -m x --allow-empty' },
      { label: 'reset', command: 'git reset --hard HEAD~1' },
      { label: 'merge', command: 'git merge other' },
      { label: 'rebase', command: 'git rebase other' },
      // 素の git stash は既存の規則 3 だけでも deny されるが、規則 8 は「main checkout 対象なら
      // 理由を問わずディレクトリで deny」するので、規則 3 が許す形 (メッセージ付き push) も
      // main checkout では deny する — 規則 3 との重複ではなく上乗せであることを確認する。
      { label: 'stash (message form rule 3 alone would allow)', command: 'git stash push -u -m tag' },
      { label: 'restore', command: 'git restore --staged file.txt' },
      { label: 'cherry-pick', command: 'git cherry-pick abc123' },
      { label: 'revert', command: 'git revert --no-edit abc123' },
      { label: 'am', command: 'git am /tmp/patch.mbox' },
      // opus レビュー (2026-09-25, bdboard-kxqb PR #775) で working tree を変える他の
      // サブコマンドの抜けを指摘され追加。clean/bisect は working tree の削除・HEAD 移動を
      // 伴い、apply/rm/mv は working tree/index を直接書き換える。
      { label: 'clean', command: 'git clean -fd' },
      { label: 'bisect', command: 'git bisect start' },
      { label: 'apply', command: 'git apply /tmp/patch.diff' },
      { label: 'rm', command: 'git rm file.txt' },
      { label: 'mv', command: 'git mv a.txt b.txt' },
      // pull だけは規則 8 の対象ではなく既存の 7a (alwaysOnServer.port 必須) 経由で deny
      // される。ここでは mainWithPort (port あり) を使うので 7a が発火し、他のエントリと
      // 同じ「main checkout では deny」という観測結果になる — 経路が違うだけ (上のコメント参照)。
      { label: 'pull', command: 'git pull --ff-only' },
    ];

    it.each(MUTATING_FORMS)(
      'denies subagent $label directly in the main checkout (cwd)',
      async ({ command }) => {
        expectDeny(
          await runBashHook({ command, cwd: mainWithPort, agentId: 'agent-1' }),
          'サブエージェント',
          'main checkout',
        );
      },
    );

    it('denies subagent checkout via git -C <main> from a worktree cwd (prefix form)', async () => {
      expectDeny(
        await runBashHook({
          command: `git -C ${mainWithPort} checkout other`,
          cwd: worktreeWithPort,
          agentId: 'agent-1',
        }),
        'main checkout',
        'git checkout',
      );
    });

    it('denies subagent commit directly in the main checkout even without alwaysOnServer.port', async () => {
      expectDeny(
        await runBashHook({ command: 'git commit -m x --allow-empty', cwd: mainNoPort, agentId: 'agent-1' }),
        'main checkout',
        'git commit',
      );
    });

    it('denies subagent reset via git -C <main> from a worktree cwd without alwaysOnServer.port', async () => {
      expectDeny(
        await runBashHook({
          command: `git -C ${mainNoPort} reset --hard HEAD~1`,
          cwd: worktreeNoPort,
          agentId: 'agent-1',
        }),
        'main checkout',
        'git reset',
      );
    });

    it('denies subagent clean directly in the main checkout even without alwaysOnServer.port', async () => {
      expectDeny(
        await runBashHook({ command: 'git clean -fdx', cwd: mainNoPort, agentId: 'agent-1' }),
        'main checkout',
        'git clean',
      );
    });

    it('allows the chair (no agent_id) to checkout in the main checkout', async () => {
      expectAllow(await runBashHook({ command: 'git checkout other', cwd: mainWithPort }));
    });

    it('allows a subagent to checkout inside a real worktree (cwd=worktree)', async () => {
      expectAllow(
        await runBashHook({ command: 'git checkout -b feature', cwd: worktreeWithPort, agentId: 'agent-1' }),
      );
    });

    it('allows a subagent targeting a worktree via git -C <worktree> from a main cwd', async () => {
      expectAllow(
        await runBashHook({
          command: `git -C ${worktreeWithPort} checkout -b feature2`,
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
      );
    });

    it('allows a subagent that cd-s into a worktree before commit (the documented workaround)', async () => {
      expectAllow(
        await runBashHook({
          command: `cd ${worktreeWithPort} && git commit -m x --allow-empty`,
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
      );
    });

    describe('always-allow list (false positives are unacceptable)', () => {
      it('allows git worktree add/remove/list in the main checkout', async () => {
        expectAllow(
          await runBashHook({
            command: `git -C ${mainWithPort} worktree list`,
            cwd: mainWithPort,
            agentId: 'agent-1',
          }),
        );
      });

      it('allows git fetch in the main checkout', async () => {
        expectAllow(await runBashHook({ command: 'git fetch', cwd: mainWithPort, agentId: 'agent-1' }));
      });

      it('allows git branch -D bd/<id> in the main checkout', async () => {
        expectAllow(
          await runBashHook({ command: 'git branch -D bd/some-ticket', cwd: mainWithPort, agentId: 'agent-1' }),
        );
      });

      it('allows git push origin --delete bd/<id> in the main checkout', async () => {
        expectAllow(
          await runBashHook({
            command: 'git push origin --delete bd/some-ticket',
            cwd: mainWithPort,
            agentId: 'agent-1',
          }),
        );
      });

      it('allows git remote prune origin in the main checkout', async () => {
        expectAllow(
          await runBashHook({ command: 'git remote prune origin', cwd: mainWithPort, agentId: 'agent-1' }),
        );
      });

      it.each(['git log --oneline -5', 'git status', 'git diff', 'git show HEAD', 'git rev-parse HEAD'])(
        'allows read-only %s in the main checkout',
        async (command) => {
          expectAllow(await runBashHook({ command, cwd: mainWithPort, agentId: 'agent-1' }));
        },
      );
    });

    describe('quoted-mention false positives', () => {
      it('allows a bd comment body that merely mentions git checkout/commit', async () => {
        expectAllow(
          await runBashHook({
            command: 'bd comment bdboard-xyz "run: git checkout other && git commit"',
            cwd: mainWithPort,
            agentId: 'agent-1',
          }),
        );
      });

      it('allows a gh pr create --body that merely mentions git reset', async () => {
        expectAllow(
          await runBashHook({
            command:
              'gh pr create --title x --body "Closes: bdboard-xyz. also ran git reset --hard earlier"',
            cwd: mainWithPort,
            agentId: 'agent-1',
          }),
        );
      });

      it('allows a git commit whose own message mentions another git -C checkout', async () => {
        // このコマンド自体は commit なので main checkout では本来 deny だが、cwd を worktree にして
        // 実コマンドは deny 対象にせず、メッセージ内の "git -C ... checkout" という文字列だけが
        // 誤検知の種にならないことを見る。
        expectAllow(
          await runBashHook({
            command: 'git commit -m "note: also tested git -C /other checkout" --allow-empty',
            cwd: worktreeWithPort,
            agentId: 'agent-1',
          }),
        );
      });
    });
  });

  describe('heredoc body masking (bdboard-u4ne)', () => {
    it('allows a bd comment body passed via a single-quoted heredoc that mentions git checkout', async () => {
      expectAllow(
        await runBashHook({
          command: `bd comment bdboard-xyz "$(cat <<'EOF'
Repro:
git checkout other
EOF
)"`,
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
      );
    });

    it('allows a git commit -m body passed via a single-quoted heredoc with a blank line and a mention of checkout', async () => {
      // このコマンド自体は commit なので main checkout では本来 deny (rule 8)。cwd を worktree にして
      // 実コマンドは deny 対象にせず、ヒアドキュメント本文内の "checkout" という単語だけが
      // 誤検知の種にならないことを見る (369行目の非ヒアドキュメント版と同じパターン)。
      expectAllow(
        await runBashHook({
          command: `git commit -m "$(cat <<'EOF'
fix: x

Details about reverting a prior checkout mistake
EOF
)"`,
          cwd: worktreeWithPort,
          agentId: 'agent-1',
        }),
      );
    });

    it('allows a gh pr create --body passed via a heredoc that mentions git reset', async () => {
      expectAllow(
        await runBashHook({
          command: `gh pr create --title x --body "$(cat <<'EOF'
Notes:
also ran git reset --hard earlier
EOF
)"`,
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
      );
    });

    it('allows an unquoted-delimiter heredoc (<<EOF, no surrounding quotes at all) whose body mentions git commit', async () => {
      expectAllow(
        await runBashHook({
          command: `cat <<EOF
git commit -m x
EOF`,
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
      );
    });

    it('still denies a real git checkout that follows a closed heredoc on a later line', async () => {
      expectDeny(
        await runBashHook({
          command: `bd comment bdboard-xyz "$(cat <<'EOF'
just a note
EOF
)"
git checkout other`,
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
        'main checkout',
        'git checkout',
      );
    });

    it('still denies a real git checkout on the line immediately after a bare (non-substituted) heredoc terminator', async () => {
      // レビュー指摘 (bdboard-u4ne PR #790 Blocker 1): 上の「later line」テストは
      // ヒアドキュメントが $(...) に包まれており、`)"` の行を挟んでから git checkout が
      // 続くため、ヒアドキュメント終端そのものの実改行ではなく `)"` の後ろの実改行が
      // 区切りとして働いていた (常にマスク対象外)。ここでは $(...) に包まれない裸の
      // ヒアドキュメントを使い、終端行 EOF の直後 (中間に他の文字を挟まず) に
      // 実コマンドを置く — 終端検出時の実改行そのものを区切りとして残せているかを見る。
      expectDeny(
        await runBashHook({
          command: `cat > notes.md <<'EOF'
hello
EOF
git checkout other`,
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
        'main checkout',
        'git checkout',
      );
    });

    it('allows a heredoc body line prefixed with the delimiter word without closing the heredoc', async () => {
      expectAllow(
        await runBashHook({
          command: `bd comment bdboard-xyz "$(cat <<'EOF'
EOFISH not the real terminator
git checkout other
EOF
)"`,
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
      );
    });

    it('does not misparse a bash arithmetic left-shift as a heredoc', async () => {
      expectAllow(await runBashHook({ command: 'echo $((1 << 2))', cwd: mainWithPort, agentId: 'agent-1' }));
    });
  });

  describe('pre-edit-guard.sh rule 2 — Edit/Write/MultiEdit/NotebookEdit', () => {
    it('denies a subagent Write of a new file directly in the main checkout', async () => {
      expectDeny(
        await runEditHook({
          toolName: 'Write',
          filePath: path.join(mainWithPort, 'newfile.txt'),
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
        'サブエージェント',
        'main checkout',
      );
    });

    it('denies a subagent Edit of an existing file directly in the main checkout', async () => {
      const target = path.join(mainWithPort, 'existing.txt');
      writeFileSync(target, 'hello\n');
      expectDeny(
        await runEditHook({ toolName: 'Edit', filePath: target, cwd: mainWithPort, agentId: 'agent-1' }),
        'main checkout',
      );
    });

    it('denies a subagent NotebookEdit directly in the main checkout', async () => {
      const notebook = path.join(mainWithPort, 'nb.ipynb');
      writeFileSync(notebook, '{}');
      expectDeny(
        await runEditHook({
          toolName: 'NotebookEdit',
          notebookPath: notebook,
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
        'main checkout',
      );
    });

    it('denies a subagent Write under a stray (non-worktree) .claude/worktrees/ subdirectory of main', async () => {
      const stray = path.join(mainWithPort, '.claude', 'worktrees', 'not-a-real-worktree');
      mkdirSync(stray, { recursive: true });
      expectDeny(
        await runEditHook({
          toolName: 'Write',
          filePath: path.join(stray, 'x.txt'),
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
        'main checkout',
      );
    });

    it('allows the chair (no agent_id) to edit a file in the main checkout', async () => {
      const target = path.join(mainWithPort, 'existing.txt');
      writeFileSync(target, 'hello\n');
      expectAllow(await runEditHook({ toolName: 'Edit', filePath: target, cwd: mainWithPort }));
    });

    it('allows a subagent to write inside a real worktree (absolute path, cwd=main)', async () => {
      expectAllow(
        await runEditHook({
          toolName: 'Write',
          filePath: path.join(worktreeWithPort, 'newfile.txt'),
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
      );
    });

    it('allows a subagent to write inside a real worktree (relative path, cwd=worktree)', async () => {
      expectAllow(
        await runEditHook({
          toolName: 'Write',
          filePath: 'newfile2.txt',
          cwd: worktreeWithPort,
          agentId: 'agent-1',
        }),
      );
    });

    it('still denies .beads/ edits on a bd/ branch inside a worktree (rule 3 unaffected by rule 2)', async () => {
      const beadsDir = path.join(worktreeWithPort, '.beads');
      mkdirSync(beadsDir, { recursive: true });
      const result = await runEditHook({
        toolName: 'Write',
        filePath: path.join(beadsDir, 'x.jsonl'),
        cwd: worktreeWithPort,
        agentId: 'agent-1',
      });
      expectDeny(result, 'PR ブランチ', '.beads/');
    });

    it('still denies editing the injected copy regardless of agent_id (rule 1 unaffected by rule 2)', async () => {
      const injected = path.join(mainWithPort, '.claude', 'skills', 'bdboard-harness', 'hooks', 'x.sh');
      mkdirSync(path.dirname(injected), { recursive: true });
      expectDeny(
        await runEditHook({ toolName: 'Write', filePath: injected, cwd: mainWithPort, agentId: 'agent-1' }),
        '.claude/skills/bdboard-harness/',
      );
    });

    it('denies a subagent Write to the main checkout shared .git/config', async () => {
      expectDeny(
        await runEditHook({
          toolName: 'Write',
          filePath: path.join(mainWithPort, '.git', 'config'),
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
        'main checkout',
      );
    });

    it('denies a subagent Write under the main checkout shared .git/hooks', async () => {
      const hooksDir = path.join(mainWithPort, '.git', 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      expectDeny(
        await runEditHook({
          toolName: 'Write',
          filePath: path.join(hooksDir, 'pre-commit'),
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
        'main checkout',
      );
    });

    it('denies a subagent Edit under the main checkout shared .git/hooks', async () => {
      const target = path.join(mainWithPort, '.git', 'hooks', 'pre-commit');
      writeFileSync(target, '#!/bin/sh\n');
      expectDeny(
        await runEditHook({ toolName: 'Edit', filePath: target, cwd: mainWithPort, agentId: 'agent-1' }),
        'main checkout',
      );
    });

    it('denies a subagent MultiEdit to the main checkout shared .git/config', async () => {
      expectDeny(
        await runEditHook({
          toolName: 'MultiEdit',
          filePath: path.join(mainWithPort, '.git', 'config'),
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
        'main checkout',
      );
    });

    it('allows the chair (no agent_id) to Write the main checkout shared .git/config', async () => {
      expectAllow(
        await runEditHook({
          toolName: 'Write',
          filePath: path.join(mainWithPort, '.git', 'config'),
          cwd: mainWithPort,
        }),
      );
    });

    it('allows a subagent to Write a regular file inside a worktree', async () => {
      expectAllow(
        await runEditHook({
          toolName: 'Write',
          filePath: path.join(worktreeWithPort, 'src', 'foo.ts'),
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
      );
    });

    it('denies a subagent Write under the main checkout .git/worktrees/<id>/ internal state', async () => {
      // .git/worktrees/<id>/ は git worktree add で作った worktree の内部状態だが、実体は
      // main checkout の .git/ 配下にある共有ファイル群 — 意図して deny 対象に含む
      // (opus レビューで確認済み。hooks/README.md 「修正済み (bdboard-1ef8)」参照)。
      expectDeny(
        await runEditHook({
          toolName: 'Write',
          filePath: path.join(mainWithPort, '.git', 'worktrees', 'wt-port', 'HEAD'),
          cwd: mainWithPort,
          agentId: 'agent-1',
        }),
        'main checkout',
      );
    });
  });
});
