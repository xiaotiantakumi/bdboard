import type { HygieneThresholds } from '../hygiene-thresholds.js';
import type { Ticket } from '../ticket.js';
import { isValidDate, pendingDecisionKey } from './shared.js';
import type { HygieneIssue } from './types.js';

const MERGE_SLOT_LABEL = 'gt:slot';

function isExcludedFromClosedWithoutEvidence(ticket: Ticket): boolean {
  if (ticket.issueType === 'epic' || ticket.issueType === 'gate') {
    return true;
  }
  return ticket.labels?.includes(MERGE_SLOT_LABEL) ?? false;
}

const PR_WORD_PATTERN = /(?:^|[^a-zA-Z0-9])PR(?:[^a-zA-Z0-9]|$)/i;

function hasPrWordMention(text: string): boolean {
  return PR_WORD_PATTERN.test(text);
}

export function hasCloseReasonEvidence(closeReason: string): boolean {
  if (hasPrWordMention(closeReason)) {
    return true;
  }
  if (/#\d+/.test(closeReason)) {
    return true;
  }
  if (/merge/i.test(closeReason)) {
    return true;
  }
  if (closeReason.includes('マージ')) {
    return true;
  }
  return false;
}

/**
 * closed_without_evidence の判定でコメント本文を引く必要があるチケットか。
 *
 * アプリ層 (get-close-evidence.ts) がフェッチ対象を絞るために使う。ここに集約
 * しないと、除外条件がドメインとアプリ層で二重管理になり、片方だけ直したときに
 * 「UI には出ないのに bd だけ叩かれる」ような無駄が静かに発生する。
 */
export function needsCloseEvidenceLookup(
  ticket: Ticket,
  now: Date,
  windowMs: number,
): boolean {
  if (ticket.status !== 'closed') {
    return false;
  }
  if (!isValidDate(ticket.closedAt)) {
    return false;
  }
  const elapsedMs = now.getTime() - ticket.closedAt.getTime();
  if (elapsedMs < 0 || elapsedMs > windowMs) {
    return false;
  }
  if (ticket.commentCount <= 0) {
    return false;
  }
  if (isExcludedFromClosedWithoutEvidence(ticket)) {
    return false;
  }
  if (ticket.closeReason !== undefined && hasCloseReasonEvidence(ticket.closeReason)) {
    return false;
  }
  return true;
}

function hasCloseEvidence(
  ticket: Ticket,
  closeEvidenceKeys: ReadonlySet<string> | undefined,
): boolean {
  const key = pendingDecisionKey(ticket.projectId, ticket.id);
  if (closeEvidenceKeys?.has(key) ?? false) {
    return true;
  }
  if (ticket.closeReason !== undefined && hasCloseReasonEvidence(ticket.closeReason)) {
    return true;
  }
  return false;
}

/**
 * close 済みだが PR/検証の記録がないチケットを拾う。
 *
 * closeReason は bd の close 理由文。コメント由来の証拠は closeEvidenceKeys で
 * 渡す (pendingCommentAnchors と同じ流儀)。未指定なら closeReason のみで判定する。
 */
export function checkClosedWithoutEvidence(
  ticket: Ticket,
  now: Date,
  thresholds: HygieneThresholds,
  closeEvidenceKeys: ReadonlySet<string> | undefined,
  closeEvidenceUnknownKeys: ReadonlySet<string> | undefined,
  closeEvidenceAvailable: boolean,
): HygieneIssue | null {
  if (!closeEvidenceAvailable) {
    return null;
  }
  if (ticket.status !== 'closed') {
    return null;
  }
  if (isExcludedFromClosedWithoutEvidence(ticket)) {
    return null;
  }
  if (!isValidDate(ticket.closedAt)) {
    return null;
  }

  const elapsedMs = now.getTime() - ticket.closedAt.getTime();
  if (elapsedMs < 0 || elapsedMs > thresholds.closedWithoutEvidenceWindowMs) {
    return null;
  }

  const key = pendingDecisionKey(ticket.projectId, ticket.id);
  if (closeEvidenceUnknownKeys?.has(key) ?? false) {
    return null;
  }

  if (hasCloseEvidence(ticket, closeEvidenceKeys)) {
    return null;
  }

  return {
    kind: 'closed_without_evidence',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message:
      'close 済みだが PR/検証の記録がない（close-template.md の書式でコメントを残す）',
    severity: 'info',
  };
}
