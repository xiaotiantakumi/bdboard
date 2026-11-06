import type { HarnessManifest, PackSummary } from './harness-pack.js';

/**
 * パックを外せない理由の種別 (bdboard-l1m1.7)。注入側の `PackInjectabilityCode` の対。
 * `code` はテストと CLI の終了処理の分岐用で、`reason` をそのまま表示する。
 */
export type PackRemovabilityCode = 'not-injected' | 'required-by-injected';

export type PackRemovability =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: PackRemovabilityCode;
      readonly reason: string;
      /** `required-by-injected` のとき、対象に (推移的に) 依存して残っているパック名。 */
      readonly dependents: readonly string[];
    };

/** `start` が `requires` を辿って (推移的に) 到達できるパック名。`start` 自身は含めない。 */
function collectTransitiveRequires(
  start: PackSummary,
  byName: ReadonlyMap<string, PackSummary>,
): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = [...start.requires];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || reached.has(name)) {
      continue;
    }
    reached.add(name);
    // レジストリに無い名前は辿れないだけ (実在の判断はここでしない)。
    const next = byName.get(name);
    if (next !== undefined) {
      pending.push(...next.requires);
    }
  }
  return reached;
}

/**
 * 注入先の注入記録に照らして、パック `targetName` を外せるかを判定する。
 *
 * - 注入記録に無いパックは外せない (`not-injected`。外すものが記録に無い)。
 * - 注入記録に残っている**他のパック**が、`requires` を辿った先 (推移的) に `targetName` を
 *   持つなら外せない (`required-by-injected`)。ベースを外す操作は、ベースを前提にした任意パック
 *   が残っている限り通らない。A→B→C のとき C を外すのも、B が残っていれば B 経由で、B が
 *   記録に無く A だけが残っている場合は A 経由で拒否する (推移閉包を見る)。
 *
 * 注入側の規則 (`evaluatePackInjectability`: 依存先が注入済みでなければ注入できない) の逆向きで、
 * 同じ `requires` を読む。レジストリに無い (= `requires` を知り得ない) 注入済みパックは依存を
 * 辿れないので、ここでは判定に含めない (`unresolvedPacks` は呼び出し側が警告に使う)。
 *
 * @param available レジストリが知っているパック一覧 (`requires` の出どころ)。
 */
export function evaluatePackRemovability(
  targetName: string,
  available: readonly PackSummary[],
  manifest: HarnessManifest,
): PackRemovability {
  const installedNames = manifest.packs.map((entry) => entry.name);
  if (!installedNames.includes(targetName)) {
    return {
      ok: false,
      code: 'not-injected',
      reason: `${targetName} は注入記録 (.claude/bdboard-packs.json) にありません。外すものがありません`,
      dependents: [],
    };
  }

  const byName = new Map(available.map((entry) => [entry.name, entry]));
  const dependents = installedNames
    .filter((name) => name !== targetName)
    .filter((name) => {
      const pack = byName.get(name);
      return pack !== undefined && collectTransitiveRequires(pack, byName).has(targetName);
    })
    .sort();

  if (dependents.length > 0) {
    return {
      ok: false,
      code: 'required-by-injected',
      reason: `${targetName} は注入済みの ${dependents.join(', ')} が前提にしているため外せません。先に ${dependents.join(', ')} を外してください`,
      dependents,
    };
  }

  return { ok: true };
}

/**
 * 注入記録にあるのにレジストリに無いパック (= `requires` を辿れず、依存の判定に入れられなかったもの)。
 * 外す操作の出力で警告するために使う。
 */
export function unresolvedInstalledPacks(
  available: readonly PackSummary[],
  manifest: HarnessManifest,
): readonly string[] {
  const known = new Set(available.map((entry) => entry.name));
  return manifest.packs
    .map((entry) => entry.name)
    .filter((name) => !known.has(name))
    .sort();
}
