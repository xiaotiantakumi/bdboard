import { describe, expect, it } from 'vitest';
import * as dto from './dto.js';

/**
 * bdboard-sso1.12: src/interface/http/dto.ts を機能別モジュール (./dto/*.ts) へ
 * 分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前の main (コミット 5c92e2c、PR #533 マージ直後) の dto.ts から
 * `grep -oE '^export (class|function|async function|const) [A-Za-z0-9_]+' src/interface/http/dto.ts`
 * で機械的に採取した値エクスポート名 (32件) をそのままハードコードしている。
 * `export interface` / `export type` は TypeScript の型のみの宣言で実行時の
 * バインディングを持たない (コンパイルで消える) ため、`Object.keys()` には現れず
 * このリストにも含めていない — 含めるべきなのは `class` / `function` /
 * `async function` / `const` の4種だけ。型エクスポート面は
 * dto-type-export-surface.check.ts が tsc (`npm run build`) で固定する。
 *
 * 分割後の dto.ts は `export * from './dto/xxx'` の再エクスポート入口のみになった。
 * ここが崩れる (関数の移し忘れ・名前の変更・re-export の欠落) と、この一覧との
 * 差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = [
  'countIncompleteTicketsFromBoard',
  'countIncompleteTicketsFromTickets',
  'toActivityEventDto',
  'toAgentProcessDto',
  'toBoardCardDto',
  'toBoardDto',
  'toBoardViewDto',
  'toCfdStatsDto',
  'toChatAgentDto',
  'toCommentDto',
  'toDependencyGraphDto',
  'toHarnessKpiDto',
  'toHygieneIssueDto',
  'toLeaseHealthDto',
  'toMergeSlotStatusDto',
  'toModelStatsDto',
  'toNonTicketHarnessWorktreeWarningDto',
  'toPrBadgeDto',
  'toProjectDto',
  'toReclaimProjectStatusDto',
  'toReclaimSchedulerStatusDto',
  'toSessionDto',
  'toSessionHistoryEntryDto',
  'toSessionTailMessageDto',
  'toStaleLeaseDto',
  'toThroughputStatsDto',
  'toTicketDetailDto',
  'toTicketInFlightOverlapDto',
  'toTicketSearchResultDto',
  'toTicketSimilarResultDto',
  'toTicketSummaryDto',
  'toTicketTokenUsageDto',
].sort();

describe('dto.ts export surface (bdboard-sso1.12 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split dto.ts', () => {
    const actual = Object.keys(dto).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
