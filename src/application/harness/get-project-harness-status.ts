import path from 'node:path';
import { compareStrings } from '../../domain/compare.js';
import {
  evaluateContractState,
  parseHarnessContract,
  resolveVerifyScriptRequirement,
  type ContractState,
  type VerifyPackageScripts,
} from '../../domain/harness-contract.js';
import { evaluateHooksState } from '../../domain/harness-hooks.js';
import type {
  HarnessManifest,
  PackSummary,
  ProjectHarnessStatus,
} from '../../domain/harness-pack.js';
import type { HarnessContractReaderPort } from '../ports/harness-contract-reader.js';
import type { PackRegistryPort } from '../ports/pack-registry.js';

/**
 * @param settingsJson 注入先の `.claude/settings.json` 本文 (無ければ null)。
 *   hook 登録状況はここからしか分からない — マニフェストの `hooks` は「注入時に
 *   何を書いたか」の記録で、その後に人が消した場合を検知できない。
 */
export function computeProjectHarnessStatus(
  availablePacks: readonly PackSummary[],
  manifest: HarnessManifest,
  contract: ContractState,
  settingsJson: string | null,
): ProjectHarnessStatus {
  const installedByName = new Map(manifest.packs.map((entry) => [entry.name, entry]));

  const packs = availablePacks
    .map((available) => {
      const installed = installedByName.get(available.name);
      const installedVersion = installed?.version ?? null;
      const drift =
        installedVersion !== null && installedVersion !== available.version;
      const hooks = evaluateHooksState(settingsJson, available);

      return {
        name: available.name,
        availableVersion: available.version,
        installedVersion,
        drift,
        hooksState: hooks.state,
        missingHooks: hooks.missingHooks,
      };
    })
    .sort((a, b) => compareStrings(a.name, b.name));

  return { packs, contract };
}

/**
 * 注入先の検証コントラクトを読んで状態にする。
 *
 * **注入済み (manifest に pack がある) プロジェクトだけ**を対象にする。未注入の
 * プロジェクトは `not-applicable` で、ファイルすら読みに行かない — bd 運用
 * プロジェクトの多くは未注入なので、そこへ一斉に「検証ループ未定義」を出すと
 * Hygiene が無視される警告で埋まる (bdboard-pkr6.3)。
 */
export async function resolveProjectContractState(
  reader: HarnessContractReaderPort,
  projectRootPath: string,
  manifest: HarnessManifest,
): Promise<ContractState> {
  if (manifest.packs.length === 0) {
    return { state: 'not-applicable' };
  }

  const text = await reader.readContract(projectRootPath);
  if (text === null) {
    return evaluateContractState(null, { verifyPackageScripts: null });
  }

  const parsed = parseHarnessContract(text);

  // verify が npm 系の run 形のときだけ、その package.json を読んで実体を確かめる。
  // `npm --prefix web run x` は web/ 側の package.json が正なので、そのディレクトリを
  // ポートに渡す (ポートは「渡された場所の package.json」しか見ない)。
  let verifyPackageScripts: VerifyPackageScripts = null;
  if (parsed.ok) {
    const requirement = resolveVerifyScriptRequirement(parsed.contract.verify);
    if (requirement !== null) {
      const packageRootPath =
        requirement.packageDir === '.'
          ? projectRootPath
          : path.join(projectRootPath, requirement.packageDir);
      verifyPackageScripts = await reader.readPackageScripts(packageRootPath);
    }
  }

  return evaluateContractState(parsed, { verifyPackageScripts });
}

export async function getProjectHarnessStatus(
  registry: PackRegistryPort,
  manifest: HarnessManifest,
  contract: ContractState,
  settingsJson: string | null,
): Promise<ProjectHarnessStatus> {
  const availablePacks = await registry.listPacks();
  return computeProjectHarnessStatus(availablePacks, manifest, contract, settingsJson);
}
