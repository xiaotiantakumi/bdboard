// bdboard-w8hr: 一時 git repo を作るテストが共有する補助 (PR #887 / bdboard-myla の後始末競合の再発防止)。
// git は commit / fetch / push の受け側 (receive-pack) の後に `git maintenance run --auto --quiet --detach` を起こし、
// これは親の git が終わった後もバックグラウンドで .git に触りうる。テスト末尾の rmSync と競うと .git が ENOTEMPTY になり、
// 無関係の PR の CI verify が落ちる。一時 repo は保守を要する大きさにならないので止めて失うものは無い。
//
// 止め方は、3 設定を書いた一時の gitconfig を環境変数 GIT_CONFIG_GLOBAL で渡す方式 (リポジトリごとの git config はやめた)。
// global スコープなので、その環境で作る全 repo (origin の bare・clone・worktree・後から作る peer) と、テスト対象の
// スクリプトが起こす git の子プロセスにも効く。GIT_CONFIG_GLOBAL は git 2.32 以降。開発者の ~/.gitconfig と XDG の
// 設定を丸ごと置き換えるので、commit.gpgsign など本物の global 設定がテストに漏れ込まなくなる副次効果もある。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';

/**
 * 一時ディレクトリの後始末 (rmSync) に渡す共通オプション。git の子 (detach した保守など) が親の git の終了後も
 * 少しだけ .git に書くことがあり、その最中に消すと ENOTEMPTY になる。Node の rmSync は maxRetries を渡すと
 * ENOTEMPTY / EBUSY / EPERM などで再試行する。待ちは再試行のたびに retryDelay × 回数 ミリ秒と伸びる
 * (線形バックオフ: 100, 200, 300, 400, 500ms。最悪で計 1.5 秒。retryDelay 固定の間隔ではない)。
 */
export const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

// 3 設定それぞれの効き方 (git 2.51 で GIT_TRACE2_EVENT の cmd_name を数えて確かめた):
// - maintenance.auto=false: commit / fetch などの後の `maintenance run --auto` を止める。git 2.51 は push の受け側
//   (receive-pack) の後の保守も `maintenance run --auto` なので、これだけで 3 か所とも止まる (本命)。
// - receive.autogc=false: push を受ける側が起こす自動保守だけを止める (2.51 では `maintenance run --auto`、
//   旧い git では `gc --auto`)。commit / fetch の保守は止めない。maintenance.auto を読まない旧い git のために書く。
// - gc.auto=0: 旧い git が直接起こす `gc --auto` と、maintenance の gc タスクを止める。これだけでは
//   `maintenance` プロセス自体は起動したままになる。
export const QUIET_GIT_CONFIG = '[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n[receive]\n\tautogc = false\n';

/** dir (既存のディレクトリ) に QUIET_GIT_CONFIG の gitconfig を書き、env に展開できる `{ GIT_CONFIG_GLOBAL }` を返す。 */
export function quietGitEnv(dir) {
  const configPath = path.join(dir, 'quiet-gitconfig');
  writeFileSync(configPath, QUIET_GIT_CONFIG);
  return { GIT_CONFIG_GLOBAL: configPath };
}

/**
 * describe の中 (またはファイルのトップレベル) で呼ぶ。そのスコープの間だけ process.env.GIT_CONFIG_GLOBAL を
 * 一時の quiet gitconfig に向け、終わったら元の値 (未設定なら未設定) に戻す。env を明示せず `...process.env` を渡す /
 * 何も渡さない spawn・execFileSync と、そこから起こされるスクリプトの git を静かにするための道具。
 */
export function useQuietGitProcessEnv() {
  let dir;
  let previous;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bdboard-quiet-git-env-'));
    previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = quietGitEnv(dir).GIT_CONFIG_GLOBAL;
  });
  afterAll(() => {
    if (previous === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = previous;
    }
    rmSync(dir, RM_OPTIONS);
  });
}
