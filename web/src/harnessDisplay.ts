import type {
  HarnessContractTicketStateAppend,
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

/**
 * Hygiene / バッジで警告として扱うべき状態か。未注入 (not-applicable) は false。
 *
 * `ok` でも、期限切れの除外が残っている・除外で候補が 0 件になったセルがある
 * ときは掃除を促すために警告扱いにする (bdboard-p5l.20)。契約自体は妥当なので
 * `invalid`/`command-missing` と表示の重さは分けたいが、放置されると気付かれない
 * ため badge の見た目は同じ「要注意」クラスに乗せる。
 */
export function harnessContractNeedsAttention(
  contract: ProjectHarnessContractDto,
): boolean {
  if (
    contract.state === 'missing' ||
    contract.state === 'invalid' ||
    contract.state === 'command-missing'
  ) {
    return true;
  }
  return (
    contract.state === 'ok' &&
    (contract.expiredExcludeCount > 0 || contract.modelExclusionWarnings.length > 0)
  );
}

/**
 * 検証コントラクト不足を直すチケットを起票できる状態か (bdboard-p5l.25)。
 * `ok` は (期限切れの除外などで) 要注意扱いでも、そもそも直すべき契約ファイルの
 * 不備が無いのでチケット起票の対象外。`not-applicable` (未注入) も対象外。
 */
export function harnessContractNeedsTicket(
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
 * モデル振り分け表の要約。「振り分け: implement 3 段宣言、review 共通」。
 *
 * 段数 = その工程が宣言した複雑度キーの数 (`*` 一本なら共通、low/med/high なら 3 段宣言)。
 * 候補のモデル名は出さない — ツールチップに収まらないうえ、DTO にも来ていない。
 */
export function formatHarnessModelRoutes(
  models: readonly ProjectHarnessModelStageDto[] | null,
): string | null {
  if (!models?.length) {
    return null;
  }
  const routeLabels = models
    .slice(0, 4)
    .map(({ stage, tiers }) => (tiers === 1 ? `${stage} 共通` : `${stage} ${tiers} 段宣言`));
  if (models.length > 4) {
    routeLabels.push(`…他 ${models.length - 4} 工程`);
  }
  return `振り分け: ${routeLabels.join('、')}`;
}

/**
 * `models.exclude` の掃除サマリ。「期限切れの除外が N 件」と、除外で候補が
 * 0 件になったセルの警告を並べる (bdboard-p5l.20)。両方 0 件なら null。
 */
export function formatHarnessModelExclusionSummary(
  contract: Extract<ProjectHarnessContractDto, { state: 'ok' }>,
): string | null {
  const parts: string[] = [];
  if (contract.expiredExcludeCount > 0) {
    parts.push(`期限切れの除外が ${contract.expiredExcludeCount} 件`);
  }
  if (contract.modelExclusionWarnings.length > 0) {
    parts.push(...contract.modelExclusionWarnings);
  }
  return parts.length === 0 ? null : parts.join(' / ');
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
      const withRoutes = routes === null ? base : `${base} / ${routes}`;
      const exclusion = formatHarnessModelExclusionSummary(contract);
      return exclusion === null ? withRoutes : `${withRoutes} / ${exclusion}`;
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

/**
 * 検証コントラクト不足を直すチケットを起票した後のフィードバック文言 (bdboard-p5l.25)。
 * `created: false` は冪等性で既存チケットを見つけたケース — 「また作った」と
 * 誤解されないよう文言を分ける。
 *
 * `stateAppend` (bdboard-13mp): 既存チケットが見つかったときだけ意味を持つ。
 * state 遷移をまたいだ陳腐化チケットの扱い — 記録済み state と現在の state が
 * 違って追記した場合は「現在の状態 <ラベル> を追記しました」と明示し、追記に
 * 失敗した場合 (fail-soft) はその旨を伝える。ラベルは `formatHarnessContractLabel`
 * を再利用し、生の state 文字列を画面に出さない。
 *
 * `contract` は**呼び出し元がポーリングでキャッシュしているものではなく、
 * このリクエストのレスポンスがサーバーから返した contract** を渡すこと
 * (レビュー指摘 bdboard-13mp)。サーバーはこのリクエスト内で契約ファイルを
 * 都度読み直してからコメントを追記しているため、クライアント側の古いキャッシュを
 * 渡すと「追記した文言なのに表示は別の (古い) 状態」というズレが起きうる —
 * まさにこのチケットが直そうとしている陳腐化を UI 側で再発させてしまう。
 */
export function buildHarnessContractTicketSuccessMessage(
  ticketId: string,
  created: boolean,
  stateAppend: HarnessContractTicketStateAppend,
  contract: ProjectHarnessContractDto,
): string {
  if (created) {
    return `チケットを起票しました: ${ticketId}`;
  }
  const base = `既存のチケットがあります: ${ticketId}`;
  switch (stateAppend) {
    case 'appended': {
      const stateLabel = formatHarnessContractLabel(contract) ?? contract.state;
      return `${base}（現在の状態 ${stateLabel} を追記しました）`;
    }
    case 'failed':
      return `${base}（現在の状態の追記に失敗しました。手動でコメントを確認してください）`;
    case 'not-needed':
      return base;
    default:
      // fetchJson はレスポンスを検証しない unchecked cast (api.ts) なので、
      // dev:web が別バージョンのサーバーに proxy している (worktree の Vite dev
      // サーバーが main checkout の常駐サーバーを指す運用、CLAUDE.md 参照) 等で
      // stateAppend が未知の値/undefined で来ても、型を信じて既存の文言に
      // フォールバックする — 素通りで壊れた文字列 ("undefined" 混入等) を
      // 出さない (レビュー指摘)。
      return base;
  }
}
