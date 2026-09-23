// bdboard-sso1.53: check-drift.mjs から move-only 分割。open PR 一覧の取得 (「gh 呼び出し」節)。
import { execFileSync } from 'node:child_process';

import { REPO_ROOT } from './git.mjs';

/**
 * gh の実行対象を決める。既定は PATH 上の `gh` そのもの。
 *
 * bdboard-b0yd R2-1: 以前のテストは `PATH: ${bin}:${process.env.PATH}` で偽の
 * `gh` を注入していたが、区切り文字 `:` が Windows (`;`) で無効なうえ、拡張子
 * なしの `#!/bin/sh` スクリプトは Windows の PATHEXT 解決に載らない。どちらも
 * 直しても「シェルに実行可能ファイルとして解決させる」という前提自体が
 * プラットフォーム依存。ここでは PATH 解決を経由せず、`BDBOARD_DRIFT_GH`
 * (既定 `gh`) を execFileSync の実行ファイルそのものとして渡し、
 * `BDBOARD_DRIFT_GH_ARGS` (JSON 配列) をその前に差し込めるようにする。
 * テストは `BDBOARD_DRIFT_GH=process.execPath` と
 * `BDBOARD_DRIFT_GH_ARGS=["<fake-gh.mjsの絶対パス>"]` を渡し、
 * `node fake-gh.mjs pr list ...` を直接起動する。シェルにも PATH にも
 * PATHEXT にも依存しないため全プラットフォームで同じ経路を通る。
 */
function ghInvocation() {
  const bin = process.env.BDBOARD_DRIFT_GH || 'gh';
  let prefixArgs = [];
  const rawPrefixArgs = process.env.BDBOARD_DRIFT_GH_ARGS;
  if (rawPrefixArgs) {
    // bdboard-b0yd R4-F1: 以前はここで JSON.parse の失敗も Array.isArray の
    // false も黙って握り潰し、既定の gh 呼び出しに倒していた。壊れた注入を
    // 無かったことにすると、テストが意図せず本物の gh を呼びに行くなど原因の
    // 分かりにくい失敗になる。ここは listOpenPullRequests() の try の中からしか
    // 呼ばれない (モジュールロード時には呼ばれない) ので、throw しても
    // 30行の Node スタックトレースにはならず、呼び出し側の catch で
    // stdout/stderr 向けの名前付き理由に変わる。
    let parsed;
    try {
      parsed = JSON.parse(rawPrefixArgs);
    } catch {
      throw new Error('BDBOARD_DRIFT_GH_ARGS is not a JSON array');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('BDBOARD_DRIFT_GH_ARGS is not a JSON array');
    }
    prefixArgs = parsed;
  }
  return { bin, prefixArgs };
}

export function listOpenPullRequests() {
  try {
    // drift は必須ゲートなので、GitHub API の障害で止めない。execFileSync は gh の
    // 非ゼロ終了でも throw するため、timeout・認証/API エラー・JSON 壊れをすべてここで
    // 非致命として扱う。shell を通さないので branch 名もコマンドとして解釈されない。
    // gh の既定30件では、並列 worktree が増えたときに件数と検出結果が黙って欠ける。
    const { bin, prefixArgs } = ghInvocation();
    const output = execFileSync(
      bin,
      [
        ...prefixArgs,
        'pr',
        'list',
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'number,headRefName,isCrossRepository',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      },
    );
    const pullRequests = JSON.parse(output);
    if (
      !Array.isArray(pullRequests) ||
      pullRequests.some(
        (pr) =>
          !Number.isInteger(pr.number) ||
          typeof pr.headRefName !== 'string' ||
          typeof pr.isCrossRepository !== 'boolean',
      )
    ) {
      throw new Error('unexpected gh JSON');
    }
    return { pullRequests };
  } catch (error) {
    // 冒頭の規範どおり、stdout だけを見る呼び出し側にも「問題なし」と
    // 「調べられなかった」の違いを残す。原因ごとに対処が違うため一行に畳んで添える。
    const reason = String(error?.message ?? error).replace(/\s+/g, ' ').trim();
    return {
      error: `drift: open PR を取得できなかったため、他 PR との比較を省略しました (${reason})`,
    };
  }
}
