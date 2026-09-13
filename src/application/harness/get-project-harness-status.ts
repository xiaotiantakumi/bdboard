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
import type { HarnessInjectorPort } from '../ports/harness-injector.js';
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
  now: Date = new Date(),
): Promise<ContractState> {
  if (manifest.packs.length === 0) {
    return { state: 'not-applicable' };
  }

  const text = await reader.readContract(projectRootPath);
  if (text === null) {
    return evaluateContractState(null, { verifyPackageScripts: null }, now);
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

  return evaluateContractState(parsed, { verifyPackageScripts }, now);
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

/** ハーネス状態を 1 プロジェクト分そろえるのに要るポート一式。 */
export interface HarnessStatusSources {
  readonly registry: PackRegistryPort;
  readonly injector: HarnessInjectorPort;
  readonly contractReader: HarnessContractReaderPort;
}

/**
 * リポジトリ根のパスだけからハーネス状態を作る。
 *
 * 単一プロジェクトをパスだけから読む経路 (プロジェクト単体の GET と、
 * エージェント実行の preflight) はここに集約する。判定の入力がバラつくと
 * 「バッジは緑なのに run は 409」のような食い違いが出るため。
 * 注入直後のレスポンスと Hygiene の一括取得は、入力 (既に読んだ manifest を
 * 持っている / 複数プロジェクトをまとめて読む) と最適化が違うので別のまま。
 */
export async function readProjectHarnessStatus(
  sources: HarnessStatusSources,
  projectRootPath: string,
  now: Date = new Date(),
): Promise<ProjectHarnessStatus> {
  const manifest = await sources.injector.readManifest(projectRootPath);
  const [contract, settingsJson] = await Promise.all([
    resolveProjectContractState(sources.contractReader, projectRootPath, manifest, now),
    sources.injector.readSettings(projectRootPath),
  ]);
  return getProjectHarnessStatus(sources.registry, manifest, contract, settingsJson);
}

/**
 * 検証コントラクトの `mainBranch` だけを読む (bdboard-pkr6.19)。Hygiene の
 * 「ハーネス凍結」がどの ref に対して遅れを測るかの優先指定に使う。
 *
 * `resolveProjectContractState` を通さないのは、あちらの `ok` 以外の状態
 * (verify の npm script が無い `command-missing` など) でも mainBranch 自体は
 * 正しく読めているため。どのブランチが main かは verify の健全性と関係ない。
 * 注入マニフェストも見ない — コントラクトのファイルがあればそれが意思表示。
 *
 * コントラクトが無い・壊れているときは undefined (呼び出し側は既定の候補順で測る)。
 * 省略時の値は `parseHarnessContract` と同じ `main`。
 */
export async function readProjectMainBranch(
  reader: HarnessContractReaderPort,
  projectRootPath: string,
): Promise<string | undefined> {
  const text = await reader.readContract(projectRootPath);
  if (text === null) {
    return undefined;
  }
  const parsed = parseHarnessContract(text);
  return parsed.ok ? parsed.contract.mainBranch : undefined;
}
