// bdboard-sso1.10 (PR-A): SettingsPanel.tsx から純粋な入力パース・検証ヘルパーを
// 移動しただけのファイル。挙動は一切変えていない。

const ABSOLUTE_WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || ABSOLUTE_WINDOWS_PATH.test(path);
}

/**
 * 保存前の軽量な事前チェック(S1: pathHint 相乗りをやめ、リスト項目に直接紐付ける形にしたため
 * ここでは true/false の判定のみを返す)。
 *
 * これは完全な検証ではなくサーバー側(scan-root-policy.ts)の判定に委ねる。
 * ここでは明白な誤操作(FSルート丸ごと指定など)を保存前に軽く警告するだけ。
 */
export function looksObviouslyDangerous(path: string): boolean {
  return path === '/' || /^[A-Za-z]:[\\/]?$/.test(path);
}

export function parseDays(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed * 24 * 60 * 60 * 1000;
}

export function parseHours(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed * 60 * 60 * 1000;
}

export function parseMinutes(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed * 60 * 1000;
}

export function parsePriorityMax(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function parseWipLimit(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}
