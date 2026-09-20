import { describe, expect, it } from 'vitest';
import * as api from './api';

/**
 * bdboard-sso1.4: web/src/api.ts を機能別モジュール (./api/*.ts) へ分割した際の、
 * 実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前の main (コミット a72c5ef, PR #522 マージ直後) の api.ts から
 * `grep -oE '^export (class|function|async function|const) [A-Za-z0-9_]+' web/src/api.ts`
 * で機械的に採取した値エクスポート名 (86件) をそのままハードコードしている。
 * `export interface` / `export type` は TypeScript の型のみの宣言で実行時の
 * バインディングを持たない (コンパイルで消える) ため、`Object.keys()` には現れず
 * このリストにも含めていない — 含めるべきなのは `class` / `function` /
 * `async function` / `const` の4種だけ。
 *
 * 分割後の api.ts は `export * from './api/xxx'` の再エクスポート入口のみになった。
 * ここが崩れる (関数の移し忘れ・名前の変更・re-export の欠落) と、この一覧との
 * 差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = [
  'ApiError',
  'ChatStreamEndedWithoutResultError',
  'LANES',
  'LANE_EXPECTED_STATUS',
  'LANE_LABELS',
  'acknowledgeChatTurn',
  'adoptDiscoveredChatSession',
  'cancelAgentRun',
  'createTunnelAccessToken',
  'deleteChatThread',
  'deleteTicketAttachment',
  'deleteTicketDependency',
  'deleteTicketLabel',
  'deleteTicketSessionLink',
  'dismissTunnelInterruption',
  'fetchActivity',
  'fetchAgentProcesses',
  'fetchAgentRun',
  'fetchAgentRunConfig',
  'fetchAiQuota',
  'fetchAiQuotaAlertConfig',
  'fetchAllHarnessStatus',
  'fetchBoard',
  'fetchBoardThresholdsConfig',
  'fetchCfdStats',
  'fetchChatAgents',
  'fetchChatAvailability',
  'fetchChatSessionMessages',
  'fetchChatThreads',
  'fetchChatTurnStatus',
  'fetchDbStats',
  'fetchDependencyGraph',
  'fetchDiscoveredChatSessions',
  'fetchHarnessKpi',
  'fetchHarnessPacks',
  'fetchHygiene',
  'fetchHygieneThresholdsConfig',
  'fetchLeaseHealth',
  'fetchMergeSlotStatus',
  'fetchModelStats',
  'fetchPendingDecisions',
  'fetchPlatformSupport',
  'fetchPrLinks',
  'fetchProjectHarnessStatus',
  'fetchProjects',
  'fetchScanRootsConfig',
  'fetchSessionHistory',
  'fetchSessionTail',
  'fetchSessions',
  'fetchSimilarTickets',
  'fetchStatus',
  'fetchThroughputStats',
  'fetchTicket',
  'fetchTicketAttachments',
  'fetchTicketComments',
  'fetchTicketInFlightOverlaps',
  'fetchTicketRuns',
  'fetchTicketTimeline',
  'fetchTunnel',
  'fetchUpdateCheck',
  'isLaneStatusMismatch',
  'patchTicketDescription',
  'patchTicketTitle',
  'postChatMessage',
  'postChatMessageStream',
  'postProjectHarnessContractTicket',
  'postProjectHarnessInject',
  'postRefresh',
  'postTicketAddLabel',
  'postTicketComment',
  'postTicketDecision',
  'postTicketDependency',
  'postTicketQuickAction',
  'postTicketQuickActionUndo',
  'postTicketSessionLink',
  'projectNameFallback',
  'putAiQuotaAlertConfig',
  'putBoardThresholdsConfig',
  'putHygieneThresholdsConfig',
  'putScanRootsConfig',
  'saveAgentRunConfig',
  'searchTickets',
  'startTicketRun',
  'startTunnel',
  'stopTunnel',
  'updateChatThread'
].sort();

describe('api.ts export surface (bdboard-sso1.4 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split api.ts', () => {
    const actual = Object.keys(api).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
