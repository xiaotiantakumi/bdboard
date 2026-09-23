import type { ContractState } from '../../domain/harness-contract.js';
import type { ProjectHarnessStatus } from '../../domain/harness-pack.js';

/**
 * harness-routes.ts (旧347行) の分割 (bdboard-sso1.56) で、複数のルートグループ
 * (status 一覧・inject・contract-ticket) から使われる変換ヘルパーをここへ移した
 * (move only, 挙動変更ゼロ)。1グループでしか使わないヘルパー・zod スキーマは
 * そのグループのルートファイルに置く (ticket-write-routes.ts 分割 bdboard-sso1.25 と
 * 同じ方針)。
 */

function decodeProjectIdParam(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export function extractProjectIdFromHarnessPath(reqPath: string): string | undefined {
  const prefix = '/api/projects/';
  const harnessSuffix = '/harness';
  const injectSuffix = '/harness/inject';
  const contractTicketSuffix = '/harness/contract-ticket';

  if (reqPath.endsWith(contractTicketSuffix)) {
    const encoded = reqPath.slice(prefix.length, reqPath.length - contractTicketSuffix.length);
    return encoded.length > 0 ? decodeProjectIdParam(encoded) : undefined;
  }

  if (reqPath.endsWith(injectSuffix)) {
    const encoded = reqPath.slice(prefix.length, reqPath.length - injectSuffix.length);
    return encoded.length > 0 ? decodeProjectIdParam(encoded) : undefined;
  }

  if (reqPath.endsWith(harnessSuffix)) {
    const encoded = reqPath.slice(prefix.length, reqPath.length - harnessSuffix.length);
    return encoded.length > 0 ? decodeProjectIdParam(encoded) : undefined;
  }

  return undefined;
}

/**
 * ContractState をそのまま JSON に落とす。状態ごとに明示的に書き出すのは、
 * ドメイン側に内部向けフィールドが増えたときに黙って API へ漏れないようにするため。
 */
export function toContractJson(contract: ContractState): Record<string, unknown> {
  switch (contract.state) {
    case 'ok':
      return {
        state: 'ok',
        verify: contract.verify,
        prFlow: contract.prFlow,
        mainBranch: contract.mainBranch,
        // 候補列そのものではなく要約 (工程名と段数) だけ。UI は段数しか使わず、
        // 注入先由来の文字列を API へ広げる理由が無い。
        models:
          contract.models === null
            ? null
            : contract.models.map((stage) => ({
                stage: stage.stage,
                tiers: stage.tiers,
              })),
        expiredExcludeCount: contract.expiredExcludeCount,
        modelExclusionWarnings: contract.modelExclusionWarnings,
      };
    case 'invalid':
      return { state: 'invalid', message: contract.message };
    case 'command-missing':
      return {
        state: 'command-missing',
        script: contract.script,
        verify: contract.verify,
      };
    case 'missing':
    case 'not-applicable':
      return { state: contract.state };
  }
}

export function toHarnessStatusJson(status: ProjectHarnessStatus): Record<string, unknown> {
  return {
    packs: status.packs.map((entry) => ({
      name: entry.name,
      availableVersion: entry.availableVersion,
      installedVersion: entry.installedVersion,
      drift: entry.drift,
      hooksState: entry.hooksState,
      missingHooks: entry.missingHooks,
    })),
    contract: toContractJson(status.contract),
  };
}
