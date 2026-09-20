import { isPlainObject } from './shared.js';
import {
  MODEL_STAGE_KEY_PATTERN,
  MODEL_STAGE_MAX_COUNT,
  describeContractValue,
  isModelComplexityKey,
  parseModelCandidates,
} from './model-candidates.js';
import { parseModelExclude } from './model-exclude.js';
import { HARNESS_MODEL_WILDCARD, HARNESS_MODEL_COMPLEXITIES } from './types.js';
import type {
  HarnessContractModels,
  HarnessModelCandidate,
  HarnessModelComplexityKey,
  HarnessModelStageRoute,
  HarnessModelStageSummary,
} from './types.js';

type StageRouteParseResult =
  | { readonly ok: true; readonly route: HarnessModelStageRoute }
  | { readonly ok: false; readonly message: string };

function parseModelStageRoute(stage: string, value: unknown): StageRouteParseResult {
  const field = `models.routes.${stage}`;
  if (!isPlainObject(value)) {
    return { ok: false, message: `${field} はオブジェクトである必要があります` };
  }

  const cells = new Map<HarnessModelComplexityKey, readonly HarnessModelCandidate[]>();
  const declaredKeys: HarnessModelComplexityKey[] = [];

  for (const key of Object.keys(value)) {
    if (!isModelComplexityKey(key)) {
      return {
        ok: false,
        message:
          `${field} のキー ${describeContractValue(key)} は low / med / high / * のいずれかである必要があります ` +
          '(複雑度は 3 段固定で、増やせません)',
      };
    }

    const cell = parseModelCandidates(value[key], `${field}.${key}`);
    if (!cell.ok) {
      return { ok: false, message: cell.message };
    }
    cells.set(key, cell.value);
    declaredKeys.push(key);
  }

  if (declaredKeys.length === 0) {
    return {
      ok: false,
      message: `${field} は low / med / high / * のいずれかを 1 つ以上宣言する必要があります`,
    };
  }

  // `*` はあくまで既定値で、個別キーがあればそちらが勝つ。`*` が無いなら
  // 3 段すべてを要求する — 片段だけ宣言された表は、参照側が黙って何も選べない
  // 穴になる。
  const fallback = cells.get(HARNESS_MODEL_WILDCARD);
  const low = cells.get('low') ?? fallback;
  const med = cells.get('med') ?? fallback;
  const high = cells.get('high') ?? fallback;
  if (low === undefined || med === undefined || high === undefined) {
    const missing = HARNESS_MODEL_COMPLEXITIES.filter(
      (complexity) => cells.get(complexity) === undefined,
    );
    return {
      ok: false,
      message:
        `${field} は * を宣言しない場合 low / med / high をすべて宣言する必要があります ` +
        `(不足: ${missing.join(' / ')})`,
    };
  }

  return { ok: true, route: { stage, declaredKeys, low, med, high } };
}

type ModelsParseResult =
  | { readonly ok: true; readonly models: HarnessContractModels | null }
  | { readonly ok: false; readonly message: string };

/**
 * `models` 節。**省略可**で、無ければ `null` = 従来とまったく同じ挙動。
 *
 * この節を足しても `version` は 1 のまま上げない。パーサが未知キーを無視する
 * 前方互換方針なので、新しい契約を旧 bdboard が読んでも Hygiene は赤くならず、
 * 逆に `models` の無い既存プロジェクトも新 bdboard でそのまま ok になる。
 */
// parseHarnessContract (parse.ts) からのみ呼ばれる。分割前は同一ファイル内の非公開関数
// だったが、サブモジュール分割で cross-module import が必要になったため export している —
// ただし入口 (harness-contract.ts) の公開エクスポート面には含めない (分割前と同じく非公開)。
export function parseModels(value: unknown): ModelsParseResult {
  if (value === undefined) {
    return { ok: true, models: null };
  }
  if (!isPlainObject(value)) {
    return { ok: false, message: 'models はオブジェクトである必要があります' };
  }

  const routesValue = value.routes;
  if (routesValue === undefined) {
    return { ok: false, message: 'models には routes が必要です' };
  }
  if (!isPlainObject(routesValue)) {
    return { ok: false, message: 'models.routes はオブジェクトである必要があります' };
  }

  const stages = Object.keys(routesValue);
  if (stages.length === 0) {
    return {
      ok: false,
      message: 'models.routes を空にはできません（工程を 1 つ以上宣言してください）',
    };
  }
  if (stages.length > MODEL_STAGE_MAX_COUNT) {
    return {
      ok: false,
      message:
        `models.routes の工程は 1〜${MODEL_STAGE_MAX_COUNT} 個である必要があります ` +
        `(受領: ${stages.length} 個)`,
    };
  }

  const routes: HarnessModelStageRoute[] = [];
  for (const stage of stages) {
    if (!MODEL_STAGE_KEY_PATTERN.test(stage)) {
      return {
        ok: false,
        message:
          `models.routes のキー ${describeContractValue(stage)} は工程名の形式 ` +
          '(英小文字で始まる 32 文字以内の英小文字・数字・ハイフン) である必要があります',
      };
    }

    const route = parseModelStageRoute(stage, routesValue[stage]);
    if (!route.ok) {
      return { ok: false, message: route.message };
    }
    routes.push(route.route);
  }

  const exclude = parseModelExclude(value.exclude);
  if (!exclude.ok) {
    return { ok: false, message: exclude.message };
  }

  return { ok: true, models: { routes, exclude: exclude.value } };
}

/** 表示用の要約へ落とす。候補そのものは UI へ流さない。 */
export function summarizeHarnessModels(
  models: HarnessContractModels | null,
): readonly HarnessModelStageSummary[] | null {
  if (models === null) {
    return null;
  }
  return models.routes.map((route) => ({
    stage: route.stage,
    tiers: route.declaredKeys.length,
  }));
}
