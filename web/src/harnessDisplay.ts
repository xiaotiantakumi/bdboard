import type {
  HarnessPrFlowDto,
  ProjectHarnessContractDto,
  ProjectHarnessModelStageDto,
  ProjectHarnessPackStatusDto,
} from './api';

/** 注入先が検証コントラクトを置くパス。文言に埋め込むのでここに固定する。 */
export const HARNESS_CONTRACT_PATH = '.claude/bdboard-harness.json';

/** 注入先で hook を登録するファイル。文言に埋め込むのでここに固定する。 */
export const HARNESS_SETTINGS_PATH = '.claude/settings.json';

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
  return (
    pack.installedVersion === null || pack.drift || harnessHooksNeedAttention(pack)
  );
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

/**
 * モデル振り分け表の要約。「振り分け: implement 3 段 / review 1 段」。
 *
 * 段数 = その工程が宣言した複雑度キーの数 (`*` 一本なら 1、low/med/high なら 3)。
 * 候補のモデル名は出さない — ツールチップに収まらないうえ、DTO にも来ていない。
 */
export function formatHarnessModelRoutes(
  models: readonly ProjectHarnessModelStageDto[] | null,
): string | null {
  if (models === null || models.length === 0) {
    return null;
  }
  return `振り分け: ${models
    .map(({ stage, tiers }) => `${stage} ${tiers} 段`)
    .join(' / ')}`;
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
    case 'ok': {
      const base = `検証: ${contract.verify} / ${PR_FLOW_LABELS[contract.prFlow]} / main: ${contract.mainBranch}`;
      const routes = formatHarnessModelRoutes(contract.models);
      return routes === null ? base : `${base} / ${routes}`;
    }
    case 'not-applicable':
      return null;
  }
}

/**
 * hook 未登録を警告として出すか。
 *
 * 未導入のパック (`installedVersion === null`) は対象外 — 「まだ入れていない」
 * ことは「未導入」バッジが既に言っており、そこへ hook 未登録まで重ねると、
 * bd 運用しているだけの未注入プロジェクトが警告で埋まる (検証コントラクトを
 * `not-applicable` にしたのと同じ理由 / bdboard-pkr6.3)。宣言 0 件の
 * `none-declared` も当然対象外。
 */
export function harnessHooksNeedAttention(
  pack: ProjectHarnessPackStatusDto,
): boolean {
  if (pack.installedVersion === null) {
    return false;
  }
  return pack.hooksState === 'missing' || pack.hooksState === 'partial';
}

/** バッジ本体。drift バッジと同じ短さに保つ。 */
export function formatHarnessHooksLabel(
  pack: ProjectHarnessPackStatusDto,
): string {
  return `hook 未登録 (${pack.missingHooks.length})`;
}

/** ツールチップ用。何をすれば直るかまで書く。 */
export function formatHarnessHooksDetail(
  pack: ProjectHarnessPackStatusDto,
): string {
  const suffix =
    pack.hooksState === 'partial'
      ? `一部の hook が ${HARNESS_SETTINGS_PATH} にありません`
      : `hook が ${HARNESS_SETTINGS_PATH} に登録されていません`;
  return `${pack.name}: ${suffix}。「再注入」で登録されます (既存の設定は保持されます)。未登録: ${pack.missingHooks.join(', ')}`;
}

/** Hygiene 行の本文。 */
export function buildHarnessHooksMessage(
  pack: ProjectHarnessPackStatusDto,
): string {
  return `${pack.name}: hook ${pack.missingHooks.length} 件が ${HARNESS_SETTINGS_PATH} に未登録です (再注入で解消)`;
}
