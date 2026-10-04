import { createHash } from 'node:crypto';

/**
 * 不具合報告の下書き (bdboard-4y8q.1)。docs/ISSUE-REPORTING.md 1・4節のデータモデル・
 * 指紋・上限を、外部 I/O を持たない純粋関数と型として切り出したもの。
 *
 * 公開本文の組み立てと置き換え (5節、bdboard-4y8q.2) はここに含めない。ここにあるのは
 * 「どの下書きにまとめるか (指紋)」「どれだけ溜めてよいか (上限)」だけで、公開してよい
 * 中身かどうかの判断は一切しない。
 */

/** A: 作業の進め方 / B: hook・配布スクリプト / C: bdboard 本体。 */
export type DraftKind = 'A' | 'B' | 'C';

/** posted への遷移と再発の扱いは bdboard-4y8q.4 / 4y8q.5。本チケットは pending / dismissed まで。 */
export type DraftStatus = 'pending' | 'posted' | 'dismissed';

export interface DraftEnvInfo {
  readonly bdboardVersion: string;
  readonly harnessVersion?: string;
  readonly os: string;
  readonly nodeVersion: string;
  readonly bdVersion?: string;
  readonly ghVersion?: string;
}

/** 手元だけの生データ。公開本文には使わない (設計 1節)。 */
export interface LocalOnlyContext {
  readonly symptomRaw: string;
  readonly causeRaw: string;
  readonly preventionRaw: string;
  /** 切り詰め前の生ログ。ただし ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS で末尾を切る。 */
  readonly errorTextRaw?: string;
  /** 表示用に先頭 ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS 文字へ切り詰めたもの。 */
  readonly errorTextHead?: string;
  /** 表示用に末尾 ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS 文字へ切り詰めたもの。 */
  readonly errorTextTail?: string;
  readonly errorTextTruncated: boolean;
  readonly agentNoteRaw?: string;
  readonly envInfo: DraftEnvInfo;
  /** 「大量発生」の下書きだけ: 丸め込まれた元の指紋 (上限 ISSUE_DRAFT_MAX_FOLDED_FINGERPRINTS)。 */
  readonly foldedFingerprints?: readonly string[];
}

export interface OccurredProject {
  readonly name: string;
  readonly path: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface IssueDraft {
  readonly id: string;
  readonly kind: DraftKind;
  readonly fingerprint: string;
  readonly title: string;
  readonly body: string;
  /** true なら同一指紋のマージで自動再生成しない。 */
  readonly titleEditedByUser: boolean;
  readonly bodyEditedByUser: boolean;
  readonly localOnly: LocalOnlyContext;
  readonly occurredProjects: readonly OccurredProject[];
  readonly occurrenceCount: number;
  readonly firstOccurredAt: string;
  readonly lastOccurredAt: string;
  readonly status: DraftStatus;
  readonly dismissReason?: string;
  readonly issueNumber?: number;
  readonly issueUrl?: string;
  readonly sourceTicketRef?: string;
  readonly harnessVersionAtOccurrence?: string;
  readonly draftSchemaVersion: 1;
}

/** 手元保存の errorTextRaw の上限 (文字数。超過分は末尾から切る)。設計 4節の「64KB」。 */
export const ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS = 64 * 1024;
/** 表示用の先頭・末尾それぞれの文字数。 */
export const ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS = 1000;
/** draft.json 全体 (画像を除く) の上限バイト数。 */
export const ISSUE_DRAFT_MAX_JSON_BYTES = 200 * 1024;
/**
 * 症状・原因・対策・エージェントのメモ 1 欄あたりの文字数。設計は個別の上限を決めていない。
 * 200KB の総量上限 (fitDraftToByteLimit) に収めるための、入口側の素直な上限。
 */
export const ISSUE_DRAFT_FREE_TEXT_MAX_CHARS = 8_000;
/** 1 時間 (UTC の暦時間) に作ってよい新しい下書きの数。超えた分は「大量発生」の 1 件へ。 */
export const ISSUE_DRAFT_NEW_PER_HOUR = 20;
/** 1 下書きに付けられる画像の枚数。添付画像の ATTACHMENT_MAX_COUNT_PER_TICKET と同じ値。 */
export const ISSUE_DRAFT_MAX_IMAGES = 20;
/** occurredProjects の最大件数 (超えた新しいプロジェクトは回数にだけ数える)。 */
export const ISSUE_DRAFT_MAX_PROJECTS = 100;
export const ISSUE_DRAFT_MAX_FOLDED_FINGERPRINTS = 200;
/** 見送り理由 (一言) の最大文字数。 */
export const ISSUE_DRAFT_DISMISS_REASON_MAX_CHARS = 200;

/**
 * 下書き id (添付画像のファイル名と同じ <epochMs>-<16桁hex>)。パスの構成要素になるので、
 * この形に一致しない文字列は保存層へ渡さない。
 */
const DRAFT_ID_PATTERN = /^[0-9]{1,20}-[0-9a-f]{16}$/;

export function isDraftId(value: string): boolean {
  return DRAFT_ID_PATTERN.test(value);
}

/** UTC の暦時間バケツ (例: "2026-10-04T12")。設計 4節: 60 分の壁時計窓ではなく 1 時間区切り。 */
export function hourBucketOf(at: Date): string {
  return at.toISOString().slice(0, 13);
}

const MASS_OCCURRENCE_PREFIX = 'mass-occurrence:';

/** 「大量発生」下書きの指紋。バケツ (種類 × 時間) ごとに 1 件。 */
export function massOccurrenceFingerprint(kind: DraftKind, at: Date): string {
  return `${MASS_OCCURRENCE_PREFIX}${kind}:${hourBucketOf(at)}`;
}

export function isMassOccurrenceFingerprint(fingerprint: string): boolean {
  return fingerprint.startsWith(MASS_OCCURRENCE_PREFIX);
}

/**
 * エラー文を「同じ症状なら同じ文字列」に寄せる (設計 4節)。best-effort で、目的は 1 件に
 * まとめることだけ。公開本文の安全性はこの関数ではなく bdboard-4y8q.2 が担う。
 * 設計の例と順序を一つだけ変えた: ISO 時刻を行:列の置換より先に行う (後だと時刻の
 * "12:34:56" が先に行:列として食われ、時刻の置換が効かなくなるため)。
 */
export function normalizeErrorText(text: string): string {
  return text
    .replace(/\/(Users|home)\/[^\s'"]+/g, '<path>')
    .replace(/~\/[^\s'"]*/g, '<path>')
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.Z-]+/g, '<time>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/:\d+:\d+\b/g, ':<loc>:<loc>')
    .replace(/\d+/g, '<n>')
    .toLowerCase()
    .trim();
}

export interface FingerprintInput {
  readonly kind: DraftKind;
  /** A のみ: failure-catalog の短い名前。 */
  readonly catalogSlug?: string;
  /** B/C の出どころ (hook 名・スクリプト名・API のパスなど)。 */
  readonly source?: string;
  readonly errorText?: string;
  /** errorText が無いときに指紋の材料にする。 */
  readonly symptom?: string;
}

/**
 * 指紋を作る (設計 4節)。A は "A:<slug>"、B/C は "<kind>:<source>:<正規化したエラー文の
 * sha256 先頭16桁>"。材料 (A の slug、B/C の source) が無ければ undefined。
 */
export function computeDraftFingerprint(input: FingerprintInput): string | undefined {
  if (input.kind === 'A') {
    const slug = input.catalogSlug?.trim();
    return slug === undefined || slug === '' ? undefined : `A:${slug}`;
  }
  const source = input.source?.trim();
  if (source === undefined || source === '') return undefined;
  const text =
    input.errorText !== undefined && input.errorText !== '' ? input.errorText : (input.symptom ?? '');
  const hash = createHash('sha256').update(normalizeErrorText(text)).digest('hex').slice(0, 16);
  return `${input.kind}:${source}:${hash}`;
}

export interface ErrorTextSummary {
  readonly head: string;
  readonly tail: string;
  readonly truncated: boolean;
  readonly omittedChars: number;
}

/** 長いエラー文は先頭と末尾だけ残す。短ければそのまま head に入れ、tail は空。 */
export function summarizeErrorText(text: string): ErrorTextSummary {
  const edge = ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS;
  if (text.length <= edge * 2) {
    return { head: text, tail: '', truncated: false, omittedChars: 0 };
  }
  return {
    head: text.slice(0, edge),
    tail: text.slice(text.length - edge),
    truncated: true,
    omittedChars: text.length - edge * 2,
  };
}

/** 手元保存する生ログの上限。超過分は末尾から切る。 */
export function capErrorTextRaw(text: string): string {
  return text.length > ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS
    ? text.slice(0, ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS)
    : text;
}

/** 自由記述 1 欄の上限。超過分は末尾から切る。 */
export function capFreeText(text: string): string {
  return text.length > ISSUE_DRAFT_FREE_TEXT_MAX_CHARS
    ? text.slice(0, ISSUE_DRAFT_FREE_TEXT_MAX_CHARS)
    : text;
}

type ShrinkableField = 'errorTextRaw' | 'agentNoteRaw' | 'symptomRaw' | 'causeRaw' | 'preventionRaw';
// 設計 4節: draft.json 全体の超過分は末尾から切る。いちばん大きくなりうる生ログから順に削る。
const SHRINK_ORDER: readonly ShrinkableField[] = [
  'errorTextRaw',
  'agentNoteRaw',
  'symptomRaw',
  'causeRaw',
  'preventionRaw',
];

function jsonBytes(draft: IssueDraft): number {
  return Buffer.byteLength(JSON.stringify(draft), 'utf8');
}

/**
 * draft.json (画像を除く) を maxBytes に収める。収まっていればそのまま返す。収まらなければ
 * 自由記述の欄を SHRINK_ORDER の順に、末尾から削って収める。文字数ではなくバイト数で
 * 判定する (多バイト文字だけの入力で文字数上限を守っても超えるため)。
 */
export function fitDraftToByteLimit(
  draft: IssueDraft,
  maxBytes: number = ISSUE_DRAFT_MAX_JSON_BYTES,
): IssueDraft {
  let current = draft;
  let size = jsonBytes(current);
  for (const field of SHRINK_ORDER) {
    while (size > maxBytes) {
      const value = current.localOnly[field];
      if (value === undefined || value.length === 0) break;
      // 1 文字は最大 3 バイト (BMP) として、超過分を削るのに足りる文字数を一度に落とす。
      const cut = Math.max(1, Math.ceil((size - maxBytes) / 3));
      current = {
        ...current,
        localOnly: { ...current.localOnly, [field]: value.slice(0, Math.max(0, value.length - cut)) },
      };
      size = jsonBytes(current);
    }
    if (size <= maxBytes) break;
  }
  return current;
}
