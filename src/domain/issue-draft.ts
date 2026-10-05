import { createHash } from 'node:crypto';

import { cutKeepingHead, cutKeepingTail } from './issue-draft-cut.js';

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
  /** 切り詰め前の生ログ。ただし ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS で末尾を (行の終わりで) 切る。 */
  readonly errorTextRaw?: string;
  /** 表示用に先頭 ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS 文字以下へ (行の終わりで) 切り詰めたもの。 */
  readonly errorTextHead?: string;
  /** 表示用に末尾 ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS 文字以下へ (行の始まりで) 切り詰めたもの。 */
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

/**
 * 置き換え漏れの疑い 1 件 (保存する形)。start / end はその欄 (title / body) の UTF-16 オフセット (半開区間)。
 * kind は issue-public-types.ts の SuspectedLeakKind (ここから import すると型の循環になるので文字列で持つ)。
 * 一致した文字列そのものは持たない (欄の切り出しで分かる。draft.json を大きくしない)。
 */
export interface DraftSuspectedLeak {
  readonly field: 'title' | 'body';
  readonly kind: string;
  readonly start: number;
  readonly end: number;
}

export interface IssueDraft {
  readonly id: string;
  readonly kind: DraftKind;
  readonly fingerprint: string;
  /** A のみ: failure-catalog の短い名前 (指紋から取り直さず、そのまま持つ)。 */
  readonly catalogSlug?: string;
  /** B/C のみ: 出どころ (hook 名・スクリプト名・API のパスなど)。 */
  readonly source?: string;
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
  /**
   * 利用者が直した欄 (titleEditedByUser / bodyEditedByUser が true の欄) にかけ直した置き換え漏れの疑い
   * (bdboard-4y8q.3.1、PATCH drafts/:id。issue-draft-edit.ts)。位置の順で上限まで。一度も直していない下書きには無い。
   */
  readonly suspectedLeaks?: readonly DraftSuspectedLeak[];
  /** suspectedLeaks の上限で落とした件数 (suspectedLeaks と一緒に書く。0 なら落としていない)。 */
  readonly suspectedLeaksOmitted?: number;
  readonly draftSchemaVersion: 1;
}

/** 手元保存の errorTextRaw の上限 (UTF-16 コード単位。超過分は末尾から、行の終わりで切る)。設計 4節の「64KB」。 */
export const ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS = 64 * 1024;
/** 表示用の先頭・末尾それぞれの文字数。 */
export const ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS = 1000;
/**
 * draft.json 全体 (画像を除く) の上限バイト数。ディスクに書く形 (serializeDraft) の長さで測る。
 * 手元の外から来る欄はすべて入口か fitDraftToByteLimit のどちらかで頭打ちにするので、
 * 敵対的な入力でもこの値は超えない。
 */
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
 *
 * 設計の例から二つ変えた:
 * - ISO 時刻の置換を 16 進・行:列の置換より先に行う。後だと "12:34:56.789Z" のように小数秒が
 *   あるときだけ ":34:56" が行:列に食われ、"…56.789Z" と "…56Z" が別の文字列になる
 *   (同じ書式の時刻どうしは、どちらの順でも数字が <n> になって同じ値に揃う)。
 * - 設計の例に無かったものを足した (bdboard-4y8q.1 のレビュー): UUID、7 文字の短い SHA、
 *   OS が実行ごとに作る一時ディレクトリ、Windows のユーザーパス。これらは実行のたびに値が
 *   変わるので、そのままだと同じ症状が 1 時間 20 件の枠を使い切る。
 */
export function normalizeErrorText(text: string): string {
  return text
    // C:\Users\name\…, C:/Users/name/…。JSON 文字列の中の C:\\Users\\… も拾う。
    // 次の "/Users/…" の規則より先に置く (後だと "D:/Users/…" の "D:" を残して食ってしまう)。
    .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/]+Users[\\/]+[^\s'"]+/gi, '<path>')
    .replace(/\/(Users|home)\/[^\s'"]+/g, '<path>')
    .replace(/~\/[^\s'"]*/g, '<path>')
    // /private/var/folders/…/T/…, /var/folders/…, /var/tmp/…, /tmp/…。別のパスの途中の "/tmp/" は食わない。
    .replace(/(?<![\w.~-])\/(?:private\/)?(?:var\/(?:folders|tmp)|tmp)\/[^\s'"]+/g, '<path>')
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.Z-]+/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    // 7 文字の短い git SHA。数字を 1 つ以上含むものだけ (英字だけの 7 文字は普通の単語でありうる)。
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7}\b/gi, '<id>')
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

/**
 * 長いエラー文は先頭と末尾だけ残す。短ければそのまま head に入れ、tail は空。先頭は行の終わりで、末尾は行の始まりで切り
 * (issue-draft-cut.ts。改行が近くに無ければコードポイントの境目)、サロゲートの対を割らない。そのため head・tail は
 * それぞれ ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS 以下で、omittedChars はその残り。
 */
export function summarizeErrorText(text: string): ErrorTextSummary {
  const edge = ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS;
  if (text.length <= edge * 2) {
    return { head: text, tail: '', truncated: false, omittedChars: 0 };
  }
  const head = cutKeepingHead(text, edge);
  const tail = cutKeepingTail(text, edge);
  return { head, tail, truncated: true, omittedChars: text.length - head.length - tail.length };
}

/** 手元保存する生ログの上限。超過分は末尾から、行の終わりで切る (issue-draft-cut.ts)。 */
export function capErrorTextRaw(text: string): string {
  return cutKeepingHead(text, ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS);
}

/** 自由記述 1 欄の上限。超過分は末尾から、行の終わりで切る (issue-draft-cut.ts)。 */
export function capFreeText(text: string): string {
  return cutKeepingHead(text, ISSUE_DRAFT_FREE_TEXT_MAX_CHARS);
}
