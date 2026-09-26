// harness-contract/*.ts サブモジュール間で共有する低レベルのパース補助関数。
// bdboard-sso1.22: harness-contract.ts のモジュール分割で切り出した。
//
// ここに置くのは複数サブモジュールから import される関数だけ (isPlainObject は
// model-exclude.ts / model-routes.ts / parse.ts、isSafeSingleLineValue は
// model-exclude.ts / parse.ts から使う)。1 サブモジュール内でしか使わない補助関数は
// そのサブモジュールに残し、ここへは寄せない。

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CONTRACT_TEXT_MAX_LENGTH = 200;

/**
 * 制御文字を含まず 200 文字以内か。
 *
 * `verify` / `mainBranch` は注入先のプロジェクトが書くファイル由来の**信頼できない
 * 入力**でありながら、run プロンプト (`buildRunPrompt`) と UI のコピー用シェル行
 * (`cd <worktree> && <verify>`) にそのまま埋まる。改行を通すとプロンプトへ任意の
 * 行を注入できてしまうため、ここで弾いて preflight に `harness-contract-invalid`
 * として止めさせる (bdboard-pkr6.11 レビュー指摘)。
 */
export function isSafeSingleLineValue(value: string): boolean {
  if (value.length > CONTRACT_TEXT_MAX_LENGTH) {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(value);
}
