import type {
  HarnessManifest,
  PackInjectability,
  PackInjectabilityCode,
  PackSummary,
} from './harness-pack.js';

export type { PackInjectability, PackInjectabilityCode };

const INJECTABLE: PackInjectability = { ok: true };

function reject(code: PackInjectabilityCode, reason: string): PackInjectability {
  return { ok: false, code, reason };
}

/**
 * `start` から `requires` を辿って最初に見つかった循環の経路を返す (無ければ undefined)。
 * 循環が `start` を通らなくても (依存先の先で閉じていても) 見つける — そのパックは
 * 依存を解決しきれないので注入させない。レジストリに無い名前は辿れないだけで、
 * 実在チェックは別 (`requires-pack-missing`)。
 */
function findRequiresCycle(
  start: PackSummary,
  byName: ReadonlyMap<string, PackSummary>,
): readonly string[] | undefined {
  const finished = new Set<string>();
  const trail: string[] = [];

  const visit = (pack: PackSummary): readonly string[] | undefined => {
    const onTrail = trail.indexOf(pack.name);
    if (onTrail !== -1) {
      return [...trail.slice(onTrail), pack.name];
    }
    if (finished.has(pack.name)) {
      return undefined;
    }
    trail.push(pack.name);
    for (const dependency of pack.requires) {
      const next = byName.get(dependency);
      if (next === undefined) {
        continue;
      }
      const cycle = visit(next);
      if (cycle !== undefined) {
        return cycle;
      }
    }
    trail.pop();
    finished.add(pack.name);
    return undefined;
  };

  return visit(start);
}

/**
 * pack.json の `role` / `requires` の組み合わせ規則と、注入先の注入記録に照らした
 * 依存の充足を検査する。パック 1 つ・プロジェクト 1 つぶんの純粋な判定で、
 * 「選べない理由」の唯一の置き場 (bdboard-l1m1.1)。注入前の拒否 (`injectHarnessPack`
 * → 409) と、画面に出す `injectable` (`computeProjectHarnessStatus`) が同じこの関数を
 * 通るので、規則が UI に複製されない。
 *
 * 規則 (上から順に最初に当たった理由を返す):
 * 1. `base` なのに `requires` がある。ベースは土台で、他に依存しない。
 * 2. `optional` なのに `requires` が空。任意パックは何かを前提に載るものとして宣言する。
 * 3. `requires` の依存先がレジストリに実在しない。
 * 4. `requires` を辿ると循環する。
 * 5. 依存先が注入記録 (`.claude/bdboard-packs.json`) に無い = 未注入。
 *
 * 注入済みのパックの再注入 (ドリフト解消) も同じ規則で通す。ベースは `requires` が
 * 空なので従来どおり常に通る。
 *
 * @param target 検査対象。レジストリ一覧の古さに左右されないよう、一覧ではなく
 *   この定義を正にする (一覧に同名があっても target で上書きする)。
 */
export function evaluatePackInjectability(
  target: PackSummary,
  available: readonly PackSummary[],
  manifest: HarnessManifest,
): PackInjectability {
  if (target.role === 'base' && target.requires.length > 0) {
    return reject(
      'base-has-requires',
      `${target.name} はベースですが requires (${target.requires.join(', ')}) を宣言しています。ベースは他のパックに依存できません (pack.json を直してください)`,
    );
  }

  if (target.role === 'optional' && target.requires.length === 0) {
    return reject(
      'optional-without-requires',
      `${target.name} は任意パックですが requires が空です。前提にするパック (通常はベース) を宣言してください (pack.json を直してください)`,
    );
  }

  const byName = new Map(available.map((entry) => [entry.name, entry]));
  byName.set(target.name, target);

  const missing = target.requires.filter((dependency) => !byName.has(dependency));
  if (missing.length > 0) {
    return reject(
      'requires-pack-missing',
      `${target.name} が前提にする ${missing.join(', ')} がパック一覧にありません (pack.json の requires を直してください)`,
    );
  }

  const cycle = findRequiresCycle(target, byName);
  if (cycle !== undefined) {
    return reject(
      'requires-cycle',
      `${target.name} の requires が循環しています: ${cycle.join(' → ')} (pack.json を直してください)`,
    );
  }

  const installed = new Set(manifest.packs.map((entry) => entry.name));
  const notInjected = target.requires.filter((dependency) => !installed.has(dependency));
  if (notInjected.length > 0) {
    return reject(
      'requires-not-injected',
      `${target.name} は ${notInjected.join(', ')} が未注入のため注入できません。先に ${notInjected.join(', ')} を注入してください`,
    );
  }

  return INJECTABLE;
}
