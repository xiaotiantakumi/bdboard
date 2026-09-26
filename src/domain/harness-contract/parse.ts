import { isPlainObject, isSafeSingleLineValue } from './shared.js';
import { isSafeMainBranchName } from './main-branch.js';
import { parseModels } from './model-routes.js';
import {
  DEFAULT_MAIN_BRANCH,
  HARNESS_CONTRACT_VERSION,
  HARNESS_PR_FLOWS,
} from './types.js';
import type { HarnessPrFlow, ParseHarnessContractResult } from './types.js';

function schemaFailure(message: string): ParseHarnessContractResult {
  return { ok: false, reason: 'schema', message };
}

/**
 * `.claude/bdboard-harness.json` の本文を検証コントラクトへ変換する。
 *
 * 未知キーはエラーにせず無視する (前方互換)。判定できたものだけを厳しく見る、
 * という方針: この JSON を書くのは注入先のユーザーで、bdboard の新機能が増える
 * たびに既存プロジェクトの Hygiene が赤くなるのは望ましくない。
 */
export function parseHarnessContract(text: string): ParseHarnessContractResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid-json', message: 'JSON として解釈できません' };
  }

  if (!isPlainObject(parsed)) {
    return schemaFailure('トップレベルはオブジェクトである必要があります');
  }

  if (parsed.version !== HARNESS_CONTRACT_VERSION) {
    return schemaFailure(
      `version は ${HARNESS_CONTRACT_VERSION} のみ対応です (受領: ${JSON.stringify(parsed.version)})`,
    );
  }

  if (typeof parsed.verify !== 'string' || parsed.verify.trim().length === 0) {
    return schemaFailure('verify は空でない文字列である必要があります');
  }

  if (!isSafeSingleLineValue(parsed.verify)) {
    return schemaFailure('verify に改行・制御文字は使えません (200 文字以内)');
  }

  const prFlow = parsed.prFlow;
  if (
    typeof prFlow !== 'string' ||
    !HARNESS_PR_FLOWS.includes(prFlow as HarnessPrFlow)
  ) {
    return schemaFailure('prFlow は pr / direct / none のいずれかである必要があります');
  }

  let mainBranch = DEFAULT_MAIN_BRANCH;
  if (parsed.mainBranch !== undefined) {
    if (typeof parsed.mainBranch !== 'string' || parsed.mainBranch.trim().length === 0) {
      return schemaFailure('mainBranch は空でない文字列である必要があります');
    }
    if (!isSafeSingleLineValue(parsed.mainBranch)) {
      return schemaFailure('mainBranch に改行・制御文字は使えません (200 文字以内)');
    }
    if (!isSafeMainBranchName(parsed.mainBranch.trim())) {
      return schemaFailure(
        'mainBranch は英数字と . _ / - だけのブランチ名である必要があります (先頭の - や .. など git が別の意味に読む形は不可)',
      );
    }
    mainBranch = parsed.mainBranch.trim();
  }

  const models = parseModels(parsed.models);
  if (!models.ok) {
    return schemaFailure(models.message);
  }

  return {
    ok: true,
    contract: {
      version: HARNESS_CONTRACT_VERSION,
      verify: parsed.verify.trim(),
      prFlow: prFlow as HarnessPrFlow,
      mainBranch,
      models: models.models,
    },
  };
}
