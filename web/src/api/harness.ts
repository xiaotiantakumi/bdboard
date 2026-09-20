import { fetchJson } from './http';

export interface HarnessPackSummaryDto {
  name: string;
  version: string;
  description: string;
}

/**
 * `.claude/settings.json` への hook 登録状況。`none-declared` は「そのパックが
 * hook を宣言していない」で、警告の対象外 (bdboard-pkr6.2)。
 */
export type HarnessHooksStateDto = 'ok' | 'missing' | 'partial' | 'none-declared';

export interface ProjectHarnessPackStatusDto {
  name: string;
  availableVersion: string;
  installedVersion: string | null;
  drift: boolean;
  hooksState: HarnessHooksStateDto;
  missingHooks: string[];
}

export type HarnessPrFlowDto = 'pr' | 'direct' | 'none';

/** `models` 節の要約 1 工程ぶん。候補列そのものは API に出さない。 */
export interface ProjectHarnessModelStageDto {
  stage: string;
  /** 宣言された複雑度の段数。`*` 一本なら 1、low/med/high なら 3。 */
  tiers: number;
}

/**
 * 注入先プロジェクトの検証コントラクト (`.claude/bdboard-harness.json`) の状態。
 * `not-applicable` はパック未注入のプロジェクト — UI には何も出さない。
 */
export type ProjectHarnessContractDto =
  | {
      state: 'ok';
      verify: string;
      prFlow: HarnessPrFlowDto;
      mainBranch: string;
      /** モデル振り分け表の要約。未宣言なら null。 */
      models: ProjectHarnessModelStageDto[] | null;
      /** `models.exclude` のうち評価時点で期限切れの件数。0 件なら特に出さない。 */
      expiredExcludeCount: number;
      /** 除外により候補が 0 件になったセルの警告メッセージ。invalid ではなく警告扱い。 */
      modelExclusionWarnings: string[];
    }
  | { state: 'missing' }
  | { state: 'invalid'; message: string }
  | { state: 'command-missing'; script: string; verify: string }
  | { state: 'not-applicable' };

export interface ProjectHarnessStatusDto {
  packs: ProjectHarnessPackStatusDto[];
  contract: ProjectHarnessContractDto;
}

export interface ProjectHarnessStatusEntryDto {
  projectId: string;
  packs: ProjectHarnessPackStatusDto[];
  contract: ProjectHarnessContractDto;
}

export interface AllHarnessStatusDto {
  projects: ProjectHarnessStatusEntryDto[];
}

export function fetchHarnessPacks(): Promise<HarnessPackSummaryDto[]> {
  return fetchJson<HarnessPackSummaryDto[]>('/api/harness/packs');
}

export function fetchAllHarnessStatus(): Promise<AllHarnessStatusDto> {
  return fetchJson<AllHarnessStatusDto>('/api/harness/status');
}

export function fetchProjectHarnessStatus(
  projectId: string,
): Promise<ProjectHarnessStatusDto> {
  return fetchJson<ProjectHarnessStatusDto>(
    `/api/projects/${encodeURIComponent(projectId)}/harness`,
  );
}

export function postProjectHarnessInject(
  projectId: string,
  pack: string,
): Promise<ProjectHarnessStatusDto> {
  return fetchJson<ProjectHarnessStatusDto>(
    `/api/projects/${encodeURIComponent(projectId)}/harness/inject`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pack }),
    },
  );
}

/**
 * 既存チケットへの state 変化追記の結果 (bdboard-13mp)。サーバー側
 * `HarnessContractTicketStateAppend` と同じ意味:
 * - `not-needed`: 新規作成した、または既存チケットの記録済み state が現在の
 *   state と同じで追記の必要が無かった。
 * - `appended`: 既存チケットへ「現在の状態は…」のコメントを追記した。
 * - `failed`: 追記を試みたが失敗した (fail-soft — チケット自体は見つかっている)。
 */
export type HarnessContractTicketStateAppend = 'not-needed' | 'appended' | 'failed';

/**
 * 検証コントラクト不足 (missing/invalid/command-missing) を直すチケットの起票結果
 * (bdboard-p5l.25)。`created: false` は「既存の未クローズチケットを見つけたので
 * 作らなかった」(冪等性)。`stateAppend` は state 遷移をまたいだ陳腐化チケットの
 * 扱い (bdboard-13mp) — 既存チケットが見つかったときだけ意味を持つ。
 */
export interface HarnessContractTicketResultDto {
  ticketId: string;
  created: boolean;
  stateAppend: HarnessContractTicketStateAppend;
  /**
   * サーバーがこのリクエストで実際に読んだ (再注入直前に都度取得した)
   * ProjectHarnessContractDto。呼び出し側はポーリングでキャッシュしている
   * 古い contract ではなく、必ずこれを使って「現在の状態」の文言を組み立てる
   * こと (bdboard-13mp レビュー指摘 — でないとこの機能自体が直そうとしている
   * 「古い状態を表示する」問題がクライアント側に移るだけになる)。
   */
  contract: ProjectHarnessContractDto;
}

export function postProjectHarnessContractTicket(
  projectId: string,
): Promise<HarnessContractTicketResultDto> {
  return fetchJson<HarnessContractTicketResultDto>(
    `/api/projects/${encodeURIComponent(projectId)}/harness/contract-ticket`,
    { method: 'POST' },
  );
}
