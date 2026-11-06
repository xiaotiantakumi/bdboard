import { DEFAULT_PACK_ROLE, PACK_ROLES, type PackRole } from '../../domain/harness-pack.js';

/**
 * pack.json の `role` を読む。省略は `DEFAULT_PACK_ROLE` (= base) — `role` を持たない
 * 旧形式のパックを、既存の注入先ごとそのまま動かすため。値が `base` / `optional`
 * 以外なら undefined (パックごと弾く。hooks と同じ流儀)。
 */
export function parsePackRole(value: unknown): PackRole | undefined {
  if (value === undefined) {
    return DEFAULT_PACK_ROLE;
  }
  return PACK_ROLES.find((role) => role === value);
}

/**
 * pack.json の `requires` (依存先のパック名の配列) を読む。省略は依存なし。
 * 空文字・非文字列・重複・自分自身への依存は undefined (パックごと弾く)。
 *
 * 検証は形だけ: `role: base` なのに `requires` が空でない、`optional` なのに空、
 * 依存先の実在などの組み合わせ規則は、ここでは見ない (登録パックの集合を知っている
 * 呼び出し側 — パック選択 UI など — の仕事)。
 */
export function parsePackRequires(value: unknown, selfName: string): readonly string[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const requires: string[] = [];
  for (const raw of value) {
    if (
      typeof raw !== 'string' ||
      raw.length === 0 ||
      raw === selfName ||
      requires.includes(raw)
    ) {
      return undefined;
    }
    requires.push(raw);
  }
  return requires;
}
