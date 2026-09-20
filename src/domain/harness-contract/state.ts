import { resolveVerifyScriptRequirement } from './verify-script.js';
import { countExpiredModelExcludes, computeModelExclusionWarnings } from './model-exclude.js';
import { summarizeHarnessModels } from './model-routes.js';
import type {
  ContractState,
  HarnessProjectFacts,
  ParseHarnessContractResult,
} from './types.js';

/**
 * パース結果とプロジェクトの事実から表示用の状態を作る。
 * `parsed` が null は「ファイルが無い」。
 */
/**
 * @param now 「期限切れ」判定の基準時刻。省略時は呼び出し時点の実時刻
 *   (`new Date()`) — 呼び出し側 (route/preflight) は本物の時計でよいが、
 *   テストは決定的にするため明示的に渡す (bdboard-p5l.20)。
 */
export function evaluateContractState(
  parsed: ParseHarnessContractResult | null,
  projectFacts: HarnessProjectFacts,
  now: Date = new Date(),
): ContractState {
  if (parsed === null) {
    return { state: 'missing' };
  }

  if (!parsed.ok) {
    return { state: 'invalid', message: parsed.message };
  }

  const { contract } = parsed;
  const requirement = resolveVerifyScriptRequirement(contract.verify);
  const scripts = projectFacts.verifyPackageScripts;

  if (requirement !== null && scripts !== null) {
    const commandMissing =
      scripts === 'absent' || !scripts.includes(requirement.script);
    if (commandMissing) {
      return {
        state: 'command-missing',
        script: requirement.script,
        verify: contract.verify,
      };
    }
  }

  return {
    state: 'ok',
    verify: contract.verify,
    prFlow: contract.prFlow,
    mainBranch: contract.mainBranch,
    models: summarizeHarnessModels(contract.models),
    expiredExcludeCount: countExpiredModelExcludes(contract.models, now),
    modelExclusionWarnings: computeModelExclusionWarnings(contract.models, now),
  };
}
