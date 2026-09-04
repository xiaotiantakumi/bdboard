import type {
  HarnessPrFlowDto,
  ProjectHarnessContractDto,
  ProjectHarnessPackStatusDto,
} from './api';

/** 注入先が検証コントラクトを置くパス。文言に埋め込むのでここに固定する。 */
export const HARNESS_CONTRACT_PATH = '.claude/bdboard-harness.json';

export function formatHarnessPackStatusLabel(
  pack: ProjectHarnessPackStatusDto,
): string {
  if (pack.installedVersion === null) {
    return '未導入';
  }
  if (pack.drift) {
    return `要更新 (${pack.installedVersion}→${pack.availableVersion})`;
  }
  return `v${pack.installedVersion}`;
}

export function harnessPackNeedsAction(pack: ProjectHarnessPackStatusDto): boolean {
  return pack.installedVersion === null || pack.drift;
}

export function harnessInjectButtonLabel(
  pack: ProjectHarnessPackStatusDto,
): string {
  if (pack.installedVersion === null) {
    return '注入';
  }
  if (pack.drift) {
    return '更新';
  }
  return '再注入';
}

export function buildHarnessInjectSuccessMessage(
  packName: string,
  pack: ProjectHarnessPackStatusDto,
): string {
  if (pack.installedVersion === null) {
    return `ハーネス ${packName} を注入しました`;
  }
  if (pack.drift) {
    return `ハーネス ${packName} を v${pack.availableVersion} に更新しました`;
  }
  return `ハーネス ${packName} を再注入しました`;
}

export function buildHarnessDriftMessage(pack: ProjectHarnessPackStatusDto): string {
  return `${pack.name}: v${pack.installedVersion} → v${pack.availableVersion} に更新が必要です`;
}

const PR_FLOW_LABELS: Record<HarnessPrFlowDto, string> = {
  pr: 'PR 必須',
  direct: 'main 直コミット可',
  none: 'git 運用なし',
};

/** Hygiene / バッジで警告として扱うべき状態か。未注入 (not-applicable) と ok は false。 */
export function harnessContractNeedsAttention(
  contract: ProjectHarnessContractDto,
): boolean {
  return (
    contract.state === 'missing' ||
    contract.state === 'invalid' ||
    contract.state === 'command-missing'
  );
}

/** バッジ本体。短く保ち、詳細は formatHarnessContractDetail (ツールチップ) に回す。 */
export function formatHarnessContractLabel(
  contract: ProjectHarnessContractDto,
): string | null {
  switch (contract.state) {
    case 'missing':
      return '検証ループ未定義';
    case 'invalid':
      return '検証コントラクト不正';
    case 'command-missing':
      return '検証コマンド未定義';
    case 'ok':
      return `検証: ${contract.verify}`;
    case 'not-applicable':
      return null;
  }
}

/** ツールチップ用の全文。何を直せばよいかまで書く。 */
export function formatHarnessContractDetail(
  contract: ProjectHarnessContractDto,
): string | null {
  switch (contract.state) {
    case 'missing':
      return `検証ループ未定義: ${HARNESS_CONTRACT_PATH} に検証コマンド (verify) を宣言してください`;
    case 'invalid':
      return `検証コントラクト不正: ${contract.message} (${HARNESS_CONTRACT_PATH})`;
    case 'command-missing':
      return `検証コマンド未定義: npm script ${contract.script} が無い (verify = ${contract.verify})`;
    case 'ok':
      return `検証: ${contract.verify} / ${PR_FLOW_LABELS[contract.prFlow]} / main: ${contract.mainBranch}`;
    case 'not-applicable':
      return null;
  }
}
