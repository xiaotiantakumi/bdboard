// bdboard-sso1.12: dto.ts のモジュール分割。チケット詳細(依存関係・セッション
// リンク・工程別モデル・子チケット・トークン使用量)、類似チケット検索、
// 着手中の衝突ファイル一覧の DTO。ticket-read-routes.ts が参照する (barrel 経由)。
import type { TicketTokenUsage } from '../../../application/board/get-ticket-token-usage.js';
import type { SimilarTicketHit } from '../../../application/board/find-similar-tickets.js';
import type { InFlightOverlapPeer } from '../../../domain/in-flight-overlap.js';
import type { BoardCard } from '../../../domain/board.js';
import { toTicketSummaryDto, type TicketSummaryDto } from './shared.js';

export interface DependencyEdgeDto {
  issueId: string;
  dependsOnId: string;
  kind: string;
}

/**
 * source: 'metadata' は bdboard.session メタデータ経由の手動リンク、
 * 'transcript' はトランスクリプトからの自動推定リンク(bdboard-3tw.9)。
 */
export interface TicketSessionLinkDto {
  sessionId: string;
  source: 'metadata' | 'transcript';
}

/** `bdboard.model.<工程>` メタデータ由来の、工程ごとの使用モデル。 */
export interface TicketModelDto {
  stage: string;
  model: string;
}

export interface TicketChildDto {
  id: string;
  title: string;
  lane: string;
}

export interface TicketDetailDto extends TicketSummaryDto {
  description?: string;
  notes?: string;
  dependencies: DependencyEdgeDto[];
  blockedBy: string[];
  blocks: string[];
  usage?: TicketTokenUsageDto;
  sessionLinks: TicketSessionLinkDto[];
  models: TicketModelDto[];
  children: TicketChildDto[];
}

export interface ModelUsageDto {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface TicketTokenUsageDto {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  byModel: ModelUsageDto[];
}

export interface TicketSimilarResultDto {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  score: number;
}

/** チケット詳細パネルの「衝突しうる着手中チケット」1 行ぶん */
export interface TicketInFlightOverlapDto {
  ticketId: string;
  files: string[];
}

export function toTicketDetailDto(
  card: BoardCard,
  sessionLinks: readonly TicketSessionLinkDto[] = [],
  models: readonly TicketModelDto[] = [],
  children: readonly TicketChildDto[] = [],
): TicketDetailDto {
  const summary = toTicketSummaryDto(card.ticket);

  return {
    ...summary,
    ...(card.ticket.description !== undefined
      ? { description: card.ticket.description }
      : {}),
    ...(card.ticket.notes !== undefined ? { notes: card.ticket.notes } : {}),
    dependencies: card.ticket.dependencies.map((edge) => ({
      issueId: edge.issueId,
      dependsOnId: edge.dependsOnId,
      kind: edge.kind,
    })),
    blockedBy: [...card.blockedBy],
    blocks: [...card.blocks],
    sessionLinks: [...sessionLinks],
    models: [...models],
    children: [...children],
  };
}

export function toTicketTokenUsageDto(usage: TicketTokenUsage): TicketTokenUsageDto {
  return {
    totalInputTokens: usage.totalInputTokens,
    totalOutputTokens: usage.totalOutputTokens,
    totalCacheCreationInputTokens: usage.totalCacheCreationInputTokens,
    totalCacheReadInputTokens: usage.totalCacheReadInputTokens,
    byModel: usage.byModel.map((entry) => ({
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheCreationInputTokens: entry.cacheCreationInputTokens,
      cacheReadInputTokens: entry.cacheReadInputTokens,
    })),
  };
}

export function toTicketSimilarResultDto(hit: SimilarTicketHit): TicketSimilarResultDto {
  return {
    id: hit.ticket.id,
    projectId: hit.ticket.projectId,
    projectName: hit.project.name,
    title: hit.ticket.title,
    status: hit.ticket.status,
    priority: hit.ticket.priority,
    issueType: hit.ticket.issueType,
    score: hit.score,
  };
}

export function toTicketInFlightOverlapDto(
  peer: InFlightOverlapPeer,
): TicketInFlightOverlapDto {
  return { ticketId: peer.ticketId, files: [...peer.files] };
}
