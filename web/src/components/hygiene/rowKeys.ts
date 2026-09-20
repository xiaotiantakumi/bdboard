// bdboard-sso1.11: HygienePanel.tsx から行キー生成の純粋関数を移動しただけの
// ファイル。挙動は一切変えていない。
import type { HygieneIssueDto } from '../../api';
import type { HarnessContractItem, HarnessPackItem } from './types';

/**
 * 行キー。**projectId を含める**。
 *
 * bd のチケット ID はプロジェクト内でしか一意でないので、複数プロジェクトを同時に
 * 見ているとき kind + ticketId だけでは衝突しうる。kind ごとに 1 チケット 1 行と
 * いう前提 (in_flight_file_overlap も相手をまとめて 1 行に畳んでいる) は保つ。
 */
export function issueRowKey(issue: HygieneIssueDto): string {
  const pidSuffix =
    issue.heartbeatLoop !== undefined ? `-${issue.heartbeatLoop.pid}` : '';
  return `${issue.kind}-${issue.projectId}-${issue.ticketId}${pidSuffix}`;
}

export function harnessDriftRowKey(item: HarnessPackItem): string {
  return `harness-drift-${item.projectId}-${item.pack.name}`;
}

export function harnessContractRowKey(item: HarnessContractItem): string {
  return `harness-contract-${item.projectId}`;
}

export function harnessHooksRowKey(item: HarnessPackItem): string {
  return `harness-hooks-${item.projectId}-${item.pack.name}`;
}
