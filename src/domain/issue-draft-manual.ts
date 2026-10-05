import {
  capFreeText,
  type DraftEnvInfo,
  type IssueDraft,
  type OccurredProject,
} from './issue-draft.js';
import { withRescannedLeaks } from './issue-draft-edit.js';
import { fitDraftToByteLimit } from './issue-draft-size.js';
import { autoTextOf } from './issue-draft-text.js';

/**
 * 人が画面から手で書く不具合報告 (「新しく報告」、bdboard-4y8q.6.7、docs/ISSUE-REPORTING.md 3節の `manual-drafts` の行)。
 * 外部 I/O を持たない純粋関数。保存・排他・件数の上限は application の issue-draft-manual.ts が受け持つ。
 *
 * 自動の受け取り (issue-draft-build.ts) との違い:
 * - 指紋は毎回ランダム (`C:manual:<16 桁の hex>`)。同じ文を 2 回送っても別の下書きで、まとめず、「大量発生」の下書きにも丸めない。
 * - 説明 (description) は手元だけの agentNoteRaw に入れ、公開本文の元にはしない (本文は自動の暫定の本文)。
 * - 題名は「直した題名」として保存する (titleEditedByUser: true)。1 節・5 節の「人が書く欄は症状などの手元の生データ」からのずれで、
 *   直した欄にかかる置き換え漏れの検出 (withRescannedLeaks) をそのまま通すため。置き換えはしない (検出するだけ)。
 */

/** 手書きの下書きの出どころ (source)。指紋の 2 つ目の部分にもなる。 */
export const MANUAL_DRAFT_SOURCE = 'manual';

/** 手書きの下書きの指紋の頭 (`C:manual:`)。自動の指紋も同じ頭になりうる (出どころが manual の自動の報告) ので、件数の判定は指紋の頭だけで行う。 */
export const MANUAL_FINGERPRINT_PREFIX = `C:${MANUAL_DRAFT_SOURCE}:`;

/** 1 時間 (走っている 60 分) に手で作ってよい下書きの数。自動の ISSUE_DRAFT_NEW_PER_HOUR (20 件/時) とは別に数える。 */
export const ISSUE_DRAFT_MANUAL_PER_HOUR = 20;

/** 手書きの件数を数える窓 (ミリ秒)。 */
export const ISSUE_DRAFT_MANUAL_WINDOW_MS = 60 * 60 * 1000;

/** 指紋の乱数部分: 16 桁の小文字 hex。 */
const MANUAL_KEY_PATTERN = /^[0-9a-f]{16}$/;

export function isManualFingerprint(fingerprint: string): boolean {
  return fingerprint.startsWith(MANUAL_FINGERPRINT_PREFIX);
}

/** 乱数の 16 桁 hex から指紋を作る。16 桁の小文字 hex でなければ投げる (指紋に任意の文字列を入れない)。 */
export function manualFingerprint(randomHex: string): string {
  if (!MANUAL_KEY_PATTERN.test(randomHex)) throw new Error('manual draft key must be 16 lowercase hex digits');
  return `${MANUAL_FINGERPRINT_PREFIX}${randomHex}`;
}

/** `sinceMs` (エポックミリ秒) 以降に作られた手書きの下書きの数。作った時刻は firstOccurredAt。 */
export function countManualDraftsSince(
  drafts: readonly Pick<IssueDraft, 'fingerprint' | 'firstOccurredAt'>[],
  sinceMs: number,
): number {
  let count = 0;
  for (const draft of drafts) {
    if (isManualFingerprint(draft.fingerprint) && Date.parse(draft.firstOccurredAt) >= sinceMs) count += 1;
  }
  return count;
}

export interface ManualDraftInput {
  /** 1 行の題名 (入口で 1 行・長さを検査済み)。そのまま「直した題名」になる。 */
  readonly title: string;
  /** 症状などの説明 (入口で長さを検査済み)。手元だけの agentNoteRaw に入る。 */
  readonly description: string;
  /** サーバーが埋める版。 */
  readonly envInfo: DraftEnvInfo;
  /** 報告に関わるプロジェクト。あれば漏れ検出の鍵 (名前・根のパス) になる。 */
  readonly project?: { readonly name: string; readonly path: string };
}

export interface ManualDraftMeta {
  readonly id: string;
  /** manualFingerprint() の値。 */
  readonly fingerprint: string;
  readonly nowIso: string;
}

function projectsOf(input: ManualDraftInput, nowIso: string): readonly OccurredProject[] {
  return input.project === undefined
    ? []
    : [{ name: input.project.name, path: input.project.path, firstSeenAt: nowIso, lastSeenAt: nowIso }];
}

/** 手書きの新しい下書き (status='pending'、回数 1)。 */
export function createManualDraft(input: ManualDraftInput, meta: ManualDraftMeta): IssueDraft {
  const draft: IssueDraft = {
    id: meta.id,
    kind: 'C',
    fingerprint: meta.fingerprint,
    source: MANUAL_DRAFT_SOURCE,
    title: input.title,
    body: '',
    titleEditedByUser: true,
    bodyEditedByUser: false,
    localOnly: {
      symptomRaw: '',
      causeRaw: '',
      preventionRaw: '',
      errorTextTruncated: false,
      agentNoteRaw: capFreeText(input.description),
      envInfo: input.envInfo,
    },
    occurredProjects: projectsOf(input, meta.nowIso),
    occurrenceCount: 1,
    firstOccurredAt: meta.nowIso,
    lastOccurredAt: meta.nowIso,
    status: 'pending',
    ...(input.envInfo.harnessVersion !== undefined ? { harnessVersionAtOccurrence: input.envInfo.harnessVersion } : {}),
    draftSchemaVersion: 1,
  };
  // 本文は自動の暫定の本文 (説明は入らない)。題名は直した題名なので、自動の題名では置き換えない。
  const withBody: IssueDraft = { ...draft, body: autoTextOf(draft).body };
  // 直した欄 (題名) に置き換え漏れの検出をかける。疑いも大きさに入るので、大きさの確認は検出の後。
  return fitDraftToByteLimit(withRescannedLeaks(withBody));
}
