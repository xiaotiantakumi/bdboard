import { fetchJson } from './http';

export interface AgentRunConfigDto {
  allowRemoteAgentRuns: boolean;
  defaults: { allowRemoteAgentRuns: boolean };
  version: string;
}

export type AgentRunStatusDto =
  | 'pending'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface AgentRunSummaryDto {
  id: string;
  ticketId: string;
  runner: string;
  mode: 'spawn' | 'resume';
  status: AgentRunStatusDto;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
}

/**
 * run 完了後に人が run の外で回す検証コマンド (bdboard-pkr6.11)。
 * 実行中の run と、前提が崩れているプロジェクトでは返らない。
 */
export interface AgentRunNextStepDto {
  verify: string;
  worktreePath: string;
}

/** ログと cwd はローカル画面からのみ返る (M-1)。リモートでは logRestricted が true。 */
export interface AgentRunDetailDto extends AgentRunSummaryDto {
  cwd?: string;
  log: string;
  logRestricted?: boolean;
  /** worktree の絶対パスを含むので cwd と同じくローカル限定。 */
  nextStep?: AgentRunNextStepDto;
}

export interface StartAgentRunResponseDto {
  runId: string;
  ticketId: string;
  status: 'pending';
  worktreePath: string;
  branchName: string;
  /** 既存の worktree を再利用したか（false なら新規作成）。 */
  reused: boolean;
  /**
   * 実行は止めなかったが伝えるべきこと。現状は `harness-drift`
   * (ハーネスパックが古い) のみ (bdboard-pkr6.11)。
   *
   * 現状 UI では未使用（drift はバッジ側で可視）。
   */
  warnings?: string[];
}

export function fetchAgentRunConfig(): Promise<AgentRunConfigDto> {
  return fetchJson<AgentRunConfigDto>('/api/settings/agent-runs');
}

export function saveAgentRunConfig(config: {
  allowRemoteAgentRuns: boolean;
  version: string;
}): Promise<AgentRunConfigDto> {
  return fetchJson<AgentRunConfigDto>('/api/settings/agent-runs', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export function startTicketRun(ticketId: string): Promise<StartAgentRunResponseDto> {
  return fetchJson<StartAgentRunResponseDto>('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticketId }),
  });
}

/**
 * ticketId を付けずに GET /api/runs を叩き、盤面全体の run 一覧を返す。
 * 一括実行 (bdboard-xuuz) が「既に実行中のエージェントがあるカード」を
 * 対象外にする判定に使う。サーバーの canStart / 409 already-running は
 * ticket 単位では確実に弾いてくれるが、一括実行ループはチケットごとに
 * POST /api/runs を直列で叩くため、開始に失敗した 1 件は直近 2 件の連続失敗
 * としてバッチ停止の対象に数えられる (next-up/run-loop/loop.ts) —
 * だから 409 が返ってから諦めるのではなく、選択の時点でクライアント側にも
 * 弾いておきたい。
 */
export function fetchAllAgentRuns(): Promise<{ runs: AgentRunSummaryDto[] }> {
  return fetchJson<{ runs: AgentRunSummaryDto[] }>('/api/runs');
}

export function fetchTicketRuns(ticketId: string): Promise<{ runs: AgentRunSummaryDto[] }> {
  const searchParams = new URLSearchParams({ ticketId });
  return fetchJson<{ runs: AgentRunSummaryDto[] }>(`/api/runs?${searchParams.toString()}`);
}

export function fetchAgentRun(
  runId: string,
  tailBytes?: number,
): Promise<AgentRunDetailDto> {
  const searchParams = new URLSearchParams();
  if (tailBytes !== undefined) {
    searchParams.set('tailBytes', String(tailBytes));
  }
  const query = searchParams.toString();
  const path = `/api/runs/${encodeURIComponent(runId)}${
    query.length > 0 ? `?${query}` : ''
  }`;
  return fetchJson<AgentRunDetailDto>(path);
}

export function cancelAgentRun(
  runId: string,
): Promise<{ runId: string; status: AgentRunStatusDto }> {
  return fetchJson<{ runId: string; status: AgentRunStatusDto }>(
    `/api/runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST' },
  );
}
