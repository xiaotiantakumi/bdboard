import { isTicketId } from '../../domain/ticket-id.js';
import type { TicketId } from '../../domain/ticket-id.js';

export interface ParsedReclaimOutput {
  /** パース不能なら null */
  readonly count: number | null;
  readonly summary: string;
  /**
   * stdout から拾えた回収チケットID。bd reclaim の出力形式に保証は無いので
   * 「取れたら取る」扱い(拾えなければ空配列)。
   *
   * 誤検出が残っても、これを使う側 (domain/harness-kpi.ts の computeReclaimKpi) が
   * 板面のチケットと突き合わせて一致した ID だけを指標の母数にするので、率は歪まない。
   */
  readonly ticketIds: readonly TicketId[];
}

const RECLAIM_COUNT_PATTERNS: readonly RegExp[] = [
  /reclaimed\s+(\d+)\s+issue/i,
  /(\d+)\s+issue(?:s)?\s+reclaimed/i,
  /reclaimed\s+(\d+)/i,
];

/**
 * 「回収 0 件」を明示する出力。bd 1.2.1 の空振りは `✓ No stale leases to reclaim` で
 * 数字を含まないため、これが無いと count=null (パース不能) に落ちる。5 分ごとの
 * 空振りが「件数不明の発火」として履歴に積まれてしまうので、0 として扱う。
 */
const RECLAIM_ZERO_PATTERNS: readonly RegExp[] = [
  /no\s+stale\s+leases/i,
  /nothing\s+to\s+reclaim/i,
];

/** 行頭の装飾 (`✓` / `-` / `*` / `•` など) と、トークン前後の記号 */
const LEADING_DECORATION = /^[^\p{L}\p{N}_]+/u;
const SURROUNDING_PUNCTUATION = /^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu;

/**
 * 回収されたチケットIDを行ごとに拾う。
 *
 * 実出力はこの形:
 * ```
 * ✓ Reclaimed 2 stale-lease issue(s):
 *   bd-reclaim-probe-37y (was held by Takumi Oda)
 * ```
 * ID は必ず**行頭の最初のトークン**に来る。行全体を舐めると見出し行の
 * `stale-lease` や `(was held by agent-x)` の担当者名まで `isTicketId` を通って
 * しまうので、正規表現で ID の形を作るのではなく「行頭トークンだけを候補にする」
 * 方式にしている。
 */
function extractTicketIds(text: string): readonly TicketId[] {
  const seen = new Set<TicketId>();
  const ids: TicketId[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(LEADING_DECORATION, '');
    const head = line.split(/[\s()]+/)[0] ?? '';
    const candidate = head.replace(SURROUNDING_PUNCTUATION, '');
    if (candidate.length === 0 || seen.has(candidate) || !isTicketId(candidate)) {
      continue;
    }
    seen.add(candidate);
    ids.push(candidate);
  }

  return ids;
}

/**
 * bd reclaim の stdout から回収件数と回収チケットIDを推定する。
 * 形式が変わった場合は count=null として summary のみ返す。
 */
export function parseReclaimStdout(stdout: string): ParsedReclaimOutput {
  const summary = stdout.trim();
  if (summary.length === 0) {
    return { count: 0, summary, ticketIds: [] };
  }

  const ticketIds = extractTicketIds(summary);

  for (const pattern of RECLAIM_COUNT_PATTERNS) {
    const match = summary.match(pattern);
    if (match !== null) {
      const parsed = Number.parseInt(match[1] ?? '', 10);
      if (Number.isFinite(parsed)) {
        return { count: parsed, summary, ticketIds };
      }
    }
  }

  if (RECLAIM_ZERO_PATTERNS.some((pattern) => pattern.test(summary))) {
    return { count: 0, summary, ticketIds };
  }

  return { count: null, summary, ticketIds };
}
