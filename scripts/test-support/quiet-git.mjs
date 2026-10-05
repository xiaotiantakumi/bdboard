// bdboard-w8hr: 一時 git repo を作るテストが共有する補助 (PR #887 / bdboard-myla の後始末競合の再発防止)。
// git は commit / fetch / push の受け側 (receive-pack) の後に `git maintenance run --auto --quiet --detach` を起こし、
// これは親の git が終わった後もバックグラウンドで .git に触りうる。テスト末尾の rmSync と競うと .git が ENOTEMPTY になり、
// 無関係の PR の CI verify が落ちる。一時 repo は保守を要する大きさにならないので止めて失うものは無い。
//
// 止め方は、設定を書いた一時の gitconfig を環境変数 GIT_CONFIG_GLOBAL で渡す方式 (リポジトリごとの git config はやめた)。
// global スコープなので、その環境で作る全 repo (origin の bare・clone・worktree・後から作る peer) と、テスト対象の
// スクリプトが起こす git の子プロセスにも効く。GIT_CONFIG_GLOBAL は git 2.32 以降。
// 置き換わるのは global スコープの設定ファイル (~/.gitconfig と $XDG_CONFIG_HOME/git/config) だけで、commit.gpgsign
// などの開発者の global 設定がテストに漏れ込まなくなる副次効果がある。一方、$XDG_CONFIG_HOME/git/ignore や attributes
// は引き続き読まれ、システム設定 (/etc/gitconfig) も GIT_CONFIG_NOSYSTEM=1 を立てない限り読まれる。
//
// 効くのは「GIT_CONFIG_GLOBAL を継いだ git」だけ。env を一から組み立てるテストは `...quietGitEnv(dir)` を足し、
// `...process.env` を継ぐ/何も渡さないテストと、テストのプロセス内から (モジュールが) 起こす git は
// `useQuietGitProcessEnv()` で process.env 側を静かにする。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll } from 'vitest';

/**
 * 一時ディレクトリの後始末 (rmSync) に渡す共通オプション。主対策は上の「保守を止める」ことで、これは補助。
 * Node の rmSync は maxRetries を渡すと ENOTEMPTY / EBUSY / EPERM などで再試行する。待ちは再試行のたびに
 * retryDelay × 回数 ミリ秒と伸びる (線形バックオフ: 100, 200, 300, 400, 500ms。最悪で計 1.5 秒。固定の間隔ではない)。
 * ただし再試行されるのは、子を消し終えた後の「そのディレクトリ自体の rmdir」だけで、子の列挙はやり直さない。
 * だから救えるのは、書き手が自分の一時ファイル (`*.lock` など) を自分で消して空になる類のケースで、保守が新しい
 * ファイルを作り終えていた場合は再試行しても失敗する。
 */
export const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

// 設定それぞれの効き方 (git 2.51 で GIT_TRACE2_EVENT の cmd_name を数えて確かめた):
// - maintenance.auto=false: commit / fetch などの後の `maintenance run --auto` を止める。git 2.51 は push の受け側
//   (receive-pack) の後の保守も `maintenance run --auto` なので、これだけで 3 か所とも止まる (本命)。
// - receive.autogc=false: push を受ける側が起こす自動保守だけを止める (2.51 では `maintenance run --auto`、
//   旧い git では `gc --auto`)。commit / fetch の保守は止めない。maintenance.auto を読まない旧い git のために書く。
// - gc.auto=0: 旧い git が直接起こす `gc --auto` と、maintenance の gc タスクを止める。これだけでは
//   `maintenance` プロセス自体は起動したままになる。
// - maintenance.autoDetach=false / gc.autoDetach=false: 保険。将来の git が別の経路で保守を起こしても、バックグラウンドへ
//   切り離さず前景で走る (親の git が戻った時点で終わっている) ので、後始末の rmSync と競合しない。
export const QUIET_GIT_CONFIG =
  '[maintenance]\n\tauto = false\n\tautoDetach = false\n[gc]\n\tauto = 0\n\tautoDetach = false\n[receive]\n\tautogc = false\n';

/** dir (既存のディレクトリ) に QUIET_GIT_CONFIG の gitconfig を書き、env に展開できる `{ GIT_CONFIG_GLOBAL }` を返す。 */
export function quietGitEnv(dir) {
  const configPath = path.join(dir, 'quiet-gitconfig');
  writeFileSync(configPath, QUIET_GIT_CONFIG);
  return { GIT_CONFIG_GLOBAL: configPath };
}

/**
 * describe の中 (またはファイルのトップレベル) で呼ぶ。そのスコープの間だけ process.env.GIT_CONFIG_GLOBAL を
 * 一時の quiet gitconfig に向け、終わったら元の値 (未設定なら未設定) に戻す。env を明示せず `...process.env` を渡す /
 * 何も渡さない spawn・execFileSync と、そこから起こされるスクリプトの git、テストのプロセス内で呼ぶモジュールの git を
 * 静かにするための道具。復元は beforeAll が返す cleanup で行うので、beforeAll が途中で失敗したときは何も書き換えず、
 * 成功したときだけ元に戻す (vi.stubEnv + vi.unstubAllEnvs にしないのは、テスト自身が unstubAllEnvs を呼ぶと
 * スコープの途中で静かさが外れるため)。
 */
export function useQuietGitProcessEnv() {
  beforeAll(() => {
    const previous = process.env.GIT_CONFIG_GLOBAL;
    const dir = mkdtempSync(path.join(tmpdir(), 'bdboard-quiet-git-env-'));
    try {
      process.env.GIT_CONFIG_GLOBAL = quietGitEnv(dir).GIT_CONFIG_GLOBAL;
    } catch (error) {
      rmSync(dir, RM_OPTIONS);
      throw error;
    }
    return () => {
      if (previous === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = previous;
      }
      rmSync(dir, RM_OPTIONS);
    };
  });
}
