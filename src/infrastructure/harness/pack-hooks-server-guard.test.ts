import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandResult } from '../../application/ports/command-runner.js';
import { NodeCommandRunner } from '../process/node-command-runner.js';

/**
 * bdboard-harness パックの pre-bash-guard.sh 規則 7 (hooks/server-guard.sh) の統合テスト
 * (bdboard-hpu8)。
 *
 * 規則 7 は「常時稼働サーバー (契約 alwaysOnServer.port) を守る」ための 3 つの判定:
 *   7a. サブエージェント (hook 入力に agent_id がある) から main checkout での git pull
 *   7b. サブエージェントから main checkout でのサーバー起動と、再起動スクリプトの実行
 *   7c. 誰からでも、listener PID (とその親) を直接 kill する / port から引いた PID を kill する
 *
 * 本物の 8787 には一切触れない。listener はこのテストプロセス自身が確保した空きポートに
 * 立てる (lsof がそのポートの listener として vitest ワーカーの PID を返す)。hook は deny
 * するだけで kill はしないので、自プロセスの PID を「守られる対象」として使える。
 *
 * pack-hooks.test.ts と同じく Windows では skip (POSIX シェル前提)。
 */

const PACKS_ROOT = fileURLToPath(new URL('../../../harness/packs/', import.meta.url));
const PRE_BASH_GUARD = path.join(PACKS_ROOT, 'bdboard-harness', 'hooks', 'pre-bash-guard.sh');

const runner = new NodeCommandRunner();

describe.skipIf(process.platform === 'win32')('bdboard-harness pre-bash-guard rule 7 (server guard)', () => {
  let tmpRoot: string;
  let mainRepo: string;
  let worktree: string;
  let env: Record<string, string>;
  let listener: Server;
  let port: number;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-server-guard-'));
    const home = path.join(tmpRoot, 'home');
    mkdirSync(home, { recursive: true });
    env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      // 規則 7 の監査ログは ${TMPDIR:-/tmp}/bdboard-server-guard.log に書く。
      TMPDIR: tmpRoot,
    };

    listener = createServer();
    port = await new Promise<number>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        const address = listener.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('listener has no port'));
          return;
        }
        resolve(address.port);
      });
    });

    mainRepo = path.join(tmpRoot, 'main');
    worktree = path.join(tmpRoot, 'wt');
    await initGitRepo(mainRepo, 'main');
    mkdirSync(path.join(mainRepo, '.claude'), { recursive: true });
    writeFileSync(
      path.join(mainRepo, '.claude', 'bdboard-harness.json'),
      JSON.stringify({
        version: 1,
        verify: 'npm run verify',
        prFlow: 'pr',
        mainBranch: 'main',
        alwaysOnServer: { port, restartScript: 'scripts/always-on-server.sh' },
      }),
    );
    await runGit(mainRepo, ['add', '.claude']);
    await runGit(mainRepo, [...GIT_IDENTITY, 'commit', '-q', '-m', 'contract']);
    await runGit(mainRepo, ['worktree', 'add', '-q', worktree, '-b', 'bd/test']);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const GIT_IDENTITY = [
    '-c',
    'user.name=bdboard-test',
    '-c',
    'user.email=bdboard-test@example.invalid',
    '-c',
    'commit.gpgsign=false',
  ];

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

  interface HookCall {
    readonly command: string;
    readonly cwd: string;
    /** 省略 = トップレベル (議長)。文字列 = サブエージェント。 */
    readonly agentId?: string;
  }

  async function runHook(call: HookCall): Promise<CommandResult> {
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

  describe('7a: git pull in the main checkout', () => {
    it('denies a subagent pulling in the main checkout (cwd)', async () => {
      expectDeny(
        await runHook({ command: 'git pull --ff-only', cwd: mainRepo, agentId: 'agent-1' }),
        'サブエージェント',
        'main checkout',
        'always-on-server.sh restart --expect-pid',
      );
    });

    it('denies a subagent that cd-s into the main checkout first (the 2026-09-20 shape)', async () => {
      expectDeny(
        await runHook({
          command: `cd ${mainRepo} && git pull --ff-only`,
          cwd: worktree,
          agentId: 'agent-1',
        }),
        'git pull',
      );
    });

    it('denies git -C <main> pull and a cd through a same-command variable', async () => {
      expectDeny(
        await runHook({ command: `git -C ${mainRepo} pull`, cwd: worktree, agentId: 'agent-1' }),
      );
      expectDeny(
        await runHook({
          command: `MAIN=${mainRepo}; cd "$MAIN" && git pull --ff-only`,
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      // main checkout の下位ディレクトリでも toplevel は main。
      expectDeny(
        await runHook({
          command: `cd ${mainRepo}/.claude && git pull`,
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
    });

    it('allows a subagent pulling its own worktree, and the chair pulling main', async () => {
      expectAllow(await runHook({ command: 'git pull --ff-only', cwd: worktree, agentId: 'agent-1' }));
      expectAllow(await runHook({ command: 'git pull --ff-only', cwd: mainRepo }));
      // ( ) のサブシェル内の cd は閉じ括弧で巻き戻る。
      expectAllow(
        await runHook({
          command: `(cd ${mainRepo} && git log -1); git pull`,
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
    });
  });

  describe('7b: starting the server / running the restart script', () => {
    it('denies a subagent starting the server from the main checkout', async () => {
      expectDeny(
        await runHook({
          command: `cd ${mainRepo} && nohup npm run start > /tmp/x.log 2>&1`,
          cwd: worktree,
          agentId: 'agent-1',
        }),
        'npm run start',
      );
      expectDeny(
        await runHook({ command: 'npm run start', cwd: mainRepo, agentId: 'agent-1' }),
      );
      expectDeny(
        await runHook({
          command: `cd ${mainRepo} && tsx src/main.ts`,
          cwd: worktree,
          agentId: 'agent-1',
        }),
        'tsx src/main.ts',
      );
    });

    it('allows worktree test servers and another port from the main checkout', async () => {
      expectAllow(await runHook({ command: 'npm run start', cwd: worktree, agentId: 'agent-1' }));
      expectAllow(
        await runHook({
          command: 'BDBOARD_PORT=18790 npm run start',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'BDBOARD_PORT=18790 npm run start',
          cwd: mainRepo,
          agentId: 'agent-1',
        }),
      );
      expectAllow(await runHook({ command: 'npm run start', cwd: mainRepo }));
    });

    it('denies a subagent running the restart script from anywhere, but not the chair', async () => {
      expectDeny(
        await runHook({
          command: 'BDBOARD_SERVER_CALLER=chair bash scripts/always-on-server.sh restart --expect-pid 1',
          cwd: worktree,
          agentId: 'agent-1',
        }),
        '再起動スクリプト',
      );
      expectAllow(
        await runHook({
          command: 'BDBOARD_SERVER_CALLER=chair bash scripts/always-on-server.sh restart --expect-pid 1',
          cwd: worktree,
        }),
      );
    });

    it('denies direct execution of the restart script without an interpreter prefix', async () => {
      expectDeny(
        await runHook({
          command: 'scripts/always-on-server.sh restart --expect-pid 1',
          cwd: worktree,
          agentId: 'agent-1',
        }),
        '再起動スクリプト',
      );
      expectDeny(
        await runHook({
          command: './scripts/always-on-server.sh restart --expect-pid 1',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectDeny(
        await runHook({
          command: 'sh scripts/always-on-server.sh restart --expect-pid 1',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
    });


    // bdboard-wa48 レビュー (opus): 狭めた一致がインタプリタのフラグやラッパー経由の
    // 迂回を見逃していないか。narrow 一致 (コマンド語 / bash・sh の直後の引数だけ) に
    // 単純化すると、これらは main の全引数走査より検知が弱くなってしまう。
    it('still denies restart-script invocations through interpreter flags, wrappers, and indirection', async () => {
      const wrappedCommands = [
        'bash -x scripts/always-on-server.sh restart',
        'timeout 600 scripts/always-on-server.sh restart',
        'zsh scripts/always-on-server.sh restart',
        'source scripts/always-on-server.sh restart',
        '. scripts/always-on-server.sh restart',
        'bash -c "scripts/always-on-server.sh restart"',
        '$(git rev-parse --show-toplevel)/scripts/always-on-server.sh restart',
        'env -i bash scripts/always-on-server.sh restart',
      ];
      for (const command of wrappedCommands) {
        expectDeny(await runHook({ command, cwd: worktree, agentId: 'agent-1' }));
      }
    });

    // bdboard-wa48: 規則 7b はもともとセグメント中の全引数位置に basename 一致を見ていたため、
    // 再起動スクリプト名をただの検索語・grep パターン・コミットメッセージに含めただけの
    // コマンドまで deny していた (fable の設計レビューでも 24h に 3 件実測)。一致はコマンド語
    // 自身、または bash/sh の直後の引数だけに絞る。
    it('allows commands that merely mention the restart script filename as an argument', async () => {
      expectAllow(
        await runHook({
          command: 'bd search "always-on-server.sh"',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'grep -r always-on-server.sh docs/',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'git log -S always-on-server.sh',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'cat scripts/always-on-server.sh',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'wc -l scripts/always-on-server.sh',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'git commit -m "docs: mention scripts/always-on-server.sh in README"',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
    });

    // bdboard-qmum: bdboard-wa48 の opus レビューで発覚。.claude/skills/bdboard-server-ops/
    // SKILL.md は status / --help / -h を「誰でも可」の読み取り専用サブコマンドとして
    // 明記しているが、7b はサブコマンドを見ずにスクリプトの呼び出し自体を全面 deny して
    // いた。直後の引数がこの3つのどれかのときだけ deny をスキップする。
    it('allows status/--help/-h for a subagent, direct or via an interpreter wrapper', async () => {
      expectAllow(
        await runHook({
          command: 'scripts/always-on-server.sh status',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'scripts/always-on-server.sh --help',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'scripts/always-on-server.sh -h',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'bash scripts/always-on-server.sh status',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
    });

    it('still denies restart/start/deploy/bare invocations of the restart script (status/--help exception is narrow)', async () => {
      expectDeny(
        await runHook({
          command: 'scripts/always-on-server.sh restart --expect-pid 1',
          cwd: worktree,
          agentId: 'agent-1',
        }),
        '再起動スクリプト',
      );
      expectDeny(
        await runHook({
          command: 'scripts/always-on-server.sh start',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectDeny(
        await runHook({ command: 'scripts/always-on-server.sh', cwd: worktree, agentId: 'agent-1' }),
      );
      expectDeny(
        await runHook({
          command: 'bash -x scripts/always-on-server.sh restart --expect-pid 1',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
    });

    it('denies a status;restart / status&&restart compound even though status alone is safe', async () => {
      expectDeny(
        await runHook({
          command:
            'scripts/always-on-server.sh status; scripts/always-on-server.sh restart --expect-pid 1',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectDeny(
        await runHook({
          command:
            'scripts/always-on-server.sh status && scripts/always-on-server.sh restart --expect-pid 1',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
    });

    // bdboard-qmum の opus 再レビューで発覚: ワイド走査は「スクリプトパスの直後のトークン」を
    // 安全判定に使うが、`bash -c '...' script.sh status` のような -c 呼び出しでは、引用符除去後に
    // フラットな引数列へ潰れた時点でスクリプトパスの直後に来るトークンは「-c 文字列へ渡る位置
    // 引数 ($0 等)」であって、実際にスクリプトへ渡る本当のサブコマンドではない (この例では -c
    // 文字列の中の "restart" が本体で、末尾の "status" は無関係な位置引数)。-c/--command トークン
    // や $ で始まるトークンが1つでもセグメント内にあれば、隣接トークンでの安全判定を諾めて
    // 無条件に deny する。
    it('denies restart smuggled past the status/--help allowlist via interpreter -c positional-parameter indirection', async () => {
      expectDeny(
        await runHook({
          command: 'bash -c \'"$0" restart --expect-pid 1\' scripts/always-on-server.sh status',
          cwd: worktree,
          agentId: 'agent-1',
        }),
        '再起動スクリプト',
      );
      expectDeny(
        await runHook({
          command: 'sh -c \'"$1" restart --expect-pid 1\' x scripts/always-on-server.sh status',
          cwd: worktree,
          agentId: 'agent-1',
        }),
        '再起動スクリプト',
      );
      expectDeny(
        await runHook({
          command: 'bash -c \'$0 restart --expect-pid 1\' scripts/always-on-server.sh -h',
          cwd: worktree,
          agentId: 'agent-1',
        }),
        '再起動スクリプト',
      );
      expectDeny(
        await runHook({
          command:
            'env X=restart bash -c \'"$0" "$X" --expect-pid 1\' scripts/always-on-server.sh --help',
          cwd: worktree,
          agentId: 'agent-1',
        }),
        '再起動スクリプト',
      );
      expectDeny(
        await runHook({
          command: 'zsh -c \'"$0" deploy --expect-pid 1\' scripts/always-on-server.sh status',
          cwd: worktree,
          agentId: 'agent-1',
        }),
        '再起動スクリプト',
      );
    });

    // -c indirection が無い、素直なラッパー越しの status/--help はこの安全側フォールバックの
    // 対象にならず、引き続き allow されることを確認する (安全側に倒しすぎて誤て誰でも可のケースまで
    // 巻き込んでいないか)。
    it('does not over-widen the -c fallback: plain interpreter-wrapped status/--help/timeout-wrapped status stay allowed', async () => {
      expectAllow(
        await runHook({
          command: 'bash scripts/always-on-server.sh status',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'bash scripts/always-on-server.sh --help',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'timeout 5 scripts/always-on-server.sh status',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
    });
  });

  // bdboard-kmh2: 同じ opus レビューで発覚した2件目。セグメント分割 (; && || & と改行で
  // split) はシェルの引用を理解しないため、引用符の中の区切り文字がセグメント境界として
  // 扱われてしまい、規則 7 の誤検知が再発しうる (「区切り文字を含まないコミットメッセージ
  // のみテスト済み」だった上の 'allows commands that merely mention...' を、区切り文字を
  // 含む場合まで広げる)。
  describe('quote-aware segmentation (bdboard-kmh2)', () => {
    it('allows a commit message whose quotes contain ";" and merely mention the restart script or npm start', async () => {
      expectAllow(
        await runHook({
          command:
            'git commit -m "fix: guard; scripts/always-on-server.sh now checks pid before restart"',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      // 旧実装 (引用符を理解しない ; 分割) では、この2発言目は
      // `git log -1 --format="reminder` / `npm run start must never run in main (port N)"`
      // の2セグメントに割れ、2セグメント目の sg_word が "npm" になり、cwd が main
      // checkout であるため 7b の npm-start チェックが誤って deny していた
      // (マスクがあれば1セグメントのまま git log として allow される)。`git commit` ではなく
      // `git log` を使うのは、規則 8 (bdboard-kxqb) が main checkout での subagent
      // `git commit` をこの引用符の中身に関係なく deny するようになり、`commit` だと
      // このテストが検証したい「7b の誤検知」ではなく規則 8 の正しい deny で落ちて
      // 区別できなくなるため。
      expectAllow(
        await runHook({
          command: `git log -1 --format="reminder; npm run start must never run in main (port ${port})"`,
          cwd: mainRepo,
          agentId: 'agent-1',
        }),
      );
    });

    it('still denies a real restart-script invocation that follows quoted decoy text after a real separator', async () => {
      expectDeny(
        await runHook({
          command:
            'git commit -m "fix: guard; harmless text"; scripts/always-on-server.sh restart --expect-pid 1',
          cwd: worktree,
          agentId: 'agent-1',
        }),
        '再起動スクリプト',
      );
    });

    // 旧実装は「引用符の中」の改行も区切りとして扱わないが、そもそも改行そのものは
    // (行継続の \改行 を除き) 元々セグメント境界として使われていた。二重引用符の
    // 中にある実改行がマスクなしだと境界として扱われ、2段落目がそのまま独立
    // セグメントになる。2段落目の先頭トークンをスクリプト名そのものにして、
    // 旧実装ではその独立セグメントの sg_word が一致して deny することを確認する。
    it('allows a multi-line double-quoted commit message whose second paragraph starts with the script name', async () => {
      expectAllow(
        await runHook({
          command:
            'git commit -m "fix: guard\n\nscripts/always-on-server.sh is mentioned here; second paragraph text"',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
    });

    // bdboard-qmum の opus 再レビューで判明: 最初の kmh2 実装は $(...) の中の引用符トグルが
    // 外側へ漏れないようにする代わりに、$(...) 自身の入れ子 (K4/K10/K15 系) や # コメント
    // (K7 系) の扱いが甘く、無害化のつもりが本物の危険なコマンドまで隠す新規の見逃しを
    // 複数含んでいた。安全側に作り直した実装は「確実に判定できる場合だけ無害化し、
    // 少しでも自信が持てなければ無害化しない (= 元の素朴な分割に戻るだけ)」を徹底しており、
    // $(...) やバッククォートの入れ子自身の中にある本物の区切り文字は意図的に無害化しない
    // (旧来の素朴な分割がこれらを偶然にも区切りとして捕まえていた挙動を保つ)。この方針の
    // もとで、ヒアドキュメント本体 (<<EOF ... EOF) は qmum 時点では特別扱いされておらず、
    // 本体行がスクリプト名で始まる独立セグメントとして deny されていた (見逃しより誤検知を
    // 選ぶ設計方針どおりの想定内の scope reduction だった)。
    //
    // bdboard-u4ne (opus レビュー 2026-09-25, PR #775 由来) でこの scope reduction 自体を
    // 解消した: ヒアドキュメントの開始 (<<EOF / <<'EOF' / <<-EOF) を検出し、対応する終端行
    // までの区間を「引用符の中と同様に確実な区間」として扱い、区間内の改行・;/&/| を空白に
    // 無害化するようになった (終端行の判定はコマンド末尾で入力が尽きる場合も含む)。そのため
    // 下のケースは今は allow が正しい — スクリプト名は本文の1行に過ぎず、実際には呼び出され
    // ていない。
    it('allows a heredoc body wrapped in outer quotes ($(cat <<\'EOF\' ... EOF)) whose body line merely mentions the script name (bdboard-u4ne: heredoc bodies are now masked)', async () => {
      const command = [
        'gh pr create --title x --body "$(cat <<\'HDEOF\'',
        'fix: guard',
        'scripts/always-on-server.sh is mentioned in passing, not invoked',
        'HDEOF',
        ')"',
      ].join('\n');
      expectAllow(await runHook({ command, cwd: worktree, agentId: 'agent-1' }));
    });

    // bdboard-qmum opus 再レビュー: $(...) の入れ子自身の中にある本物の危険なコマンドは、
    // 外側の二重引用符に包まれた入れ子の中にさらに空の "" が挙まっていても見逃さない
    // (レビューでは元の実装がここで状態がずれ、本物の git pull を隠していた)。
    it('still denies a real git pull hidden inside nested $() with empty double-quote pairs around it', async () => {
      expectDeny(
        await runHook({
          command: `echo "$(echo ""; git -C ${mainRepo} pull; echo "")"`,
          cwd: mainRepo,
          agentId: 'agent-1',
        }),
        'git pull',
      );
    });

    // 同上、バッククォートの入れ子版。
    it('still denies a real git pull hidden inside nested backticks with double-quote pairs around it', async () => {
      expectDeny(
        await runHook({
          command: `echo "\`echo "a"; git -C ${mainRepo} pull; echo "b"\`"`,
          cwd: mainRepo,
          agentId: 'agent-1',
        }),
        'git pull',
      );
    });

    // 同上、$(...) の中にシングルクォートで包んだ二重引用符1文字だけ混ぜたケース
    // (引用符の種類が入れ子の内外で食い違っても状態がずれないことを確認する)。
    it('still denies a real git pull hidden inside nested $() containing a single-quoted stray double-quote character', async () => {
      expectDeny(
        await runHook({
          command: `echo "$(echo '"'; git -C ${mainRepo} pull; true)"`,
          cwd: mainRepo,
          agentId: 'agent-1',
        }),
        'git pull',
      );
    });

    // # コメント中のアポストロフィで状態がずれ、後続の本物の git pull を見逃さないこと。
    it('still denies a real git pull on the line after a comment containing an apostrophe', async () => {
      expectDeny(
        await runHook({
          command: `# don't do this\ngit -C ${mainRepo} pull`,
          cwd: mainRepo,
          agentId: 'agent-1',
        }),
        'git pull',
      );
    });

    // 末尾コメント中のアポストロフィ版 (トップレベル、kill 検知)。
    it('still denies a real kill on the line after a trailing comment containing an apostrophe', async () => {
      expectDeny(
        await runHook({
          command: "true # it's fine\nkill " + String(process.pid),
          cwd: worktree,
        }),
      );
    });

    // $'...' (ANSI-C クオート) は専用の理解をしていないが、閉じられない/バランスしない場合は
    // 生のコマンドで判定する fail-closed の側に落ちるため、本物の危険なコマンドを見逃さない
    // ことを確認する。
    it('does not let ansi-c ($\'...\') quoting hide a real trailing git pull', async () => {
      expectDeny(
        await runHook({
          command: `echo $'\\''; git -C ${mainRepo} pull; echo ''`,
          cwd: mainRepo,
          agentId: 'agent-1',
        }),
        'git pull',
      );
    });

    // マスク関数自体の回帰ガード: 引用符の外側でバックスラッシュエスケープされた引用符
    // ('\"') を引用の開始と誤認すると、閉じ引用符が見つからないまま残り全体を引用中と
    // みなして無害化してしまい、その後ろの本物の危険なコマンドを隠しかねない (見逃し)。
    it('does not let an escaped quote outside quoting hide a real trailing restart-script invocation', async () => {
      expectDeny(
        await runHook({
          command: 'echo \\" ; scripts/always-on-server.sh restart --expect-pid 1',
          cwd: worktree,
          agentId: 'agent-1',
        }),
        '再起動スクリプト',
      );
    });

    it('still denies a plain unquoted git pull in the main checkout (no regression from the masking pass)', async () => {
      expectDeny(
        await runHook({ command: 'git pull --ff-only', cwd: mainRepo, agentId: 'agent-1' }),
        'git pull',
      );
    });
  });

  describe('7c: killing the listener', () => {
    it('denies killing the listener PID for the chair and for subagents', async () => {
      expectDeny(
        await runHook({ command: `kill ${process.pid}`, cwd: worktree }),
        `PID ${process.pid}`,
        'BDBOARD_SERVER_OVERRIDE',
      );
      expectDeny(
        await runHook({ command: `kill -9 ${process.pid}`, cwd: worktree, agentId: 'agent-1' }),
        'サブエージェントは kill も再起動もできません',
      );
      expectDeny(await runHook({ command: `kill -s TERM ${process.pid}`, cwd: mainRepo }));
    });

    it('denies PIDs derived from the port ($(...), variable, pipeline)', async () => {
      expectDeny(
        await runHook({ command: `kill $(lsof -tiTCP:${port} -sTCP:LISTEN)`, cwd: worktree }),
        `port ${port}`,
      );
      expectDeny(
        await runHook({
          command: `OLD=$(lsof -tiTCP:${port} -sTCP:LISTEN); kill $OLD`,
          cwd: worktree,
        }),
        '$OLD',
      );
      expectDeny(
        await runHook({ command: `lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill`, cwd: worktree }),
        'パイプ',
      );
    });

    it('allows kill -0, unrelated PIDs, and mentioning the port without killing it', async () => {
      expectAllow(await runHook({ command: `kill -0 ${process.pid}`, cwd: worktree }));
      expectAllow(
        await runHook({
          command: `kill 999999; curl -s http://127.0.0.1:${port}/api/health`,
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(await runHook({ command: `lsof -nP -iTCP:${port} -sTCP:LISTEN`, cwd: worktree }));
    });

    it('honours BDBOARD_SERVER_OVERRIDE for the chair only', async () => {
      expectAllow(
        await runHook({
          command: `BDBOARD_SERVER_OVERRIDE="manual stop" kill ${process.pid}`,
          cwd: worktree,
        }),
      );
      expectDeny(
        await runHook({
          command: `BDBOARD_SERVER_OVERRIDE="manual stop" kill ${process.pid}`,
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
    });

    it('writes one audit line per deny under $TMPDIR', () => {
      const auditLog = path.join(tmpRoot, 'bdboard-server-guard.log');
      const content = readFileSync(auditLog, 'utf8');
      expect(content).toContain('7a-git-pull\tagent=agent-1');
      expect(content).toContain('7c-kill-listener\tagent=top-level');
      expect(content).toContain('7b-restart-script');
    });
  });

  describe('activation', () => {
    it('stays silent when the contract has no alwaysOnServer', async () => {
      const plainRepo = path.join(tmpRoot, 'plain');
      await initGitRepo(plainRepo, 'main');
      mkdirSync(path.join(plainRepo, '.claude'), { recursive: true });
      writeFileSync(
        path.join(plainRepo, '.claude', 'bdboard-harness.json'),
        JSON.stringify({ version: 1, verify: 'npm test', prFlow: 'pr', mainBranch: 'main' }),
      );
      expectAllow(await runHook({ command: `kill ${process.pid}`, cwd: plainRepo }));
      expectAllow(await runHook({ command: 'git pull --ff-only', cwd: plainRepo, agentId: 'agent-1' }));
    });

    it('does not slow down commands that cannot touch the server (pre-filter)', async () => {
      expectAllow(await runHook({ command: 'ls -la && cat README.md', cwd: mainRepo, agentId: 'agent-1' }));
    });
  });
});
