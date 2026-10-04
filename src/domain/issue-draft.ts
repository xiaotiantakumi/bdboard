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
  readonly draftSchemaVersion: 1;
}

/** 手元保存の errorTextRaw の上限 (文字数。超過分は末尾から切る)。設計 4節の「64KB」。 */
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
 * 1 行の文字列として扱えない文字か。C0 制御文字 (改行・タブを含む)、DEL と C1 制御文字 (NEL を含む)、
 * U+2028 / U+2029 (行区切り)、そして見た目を変える不可視の文字: ゼロ幅 (U+200B-U+200F)、
 * 双方向の制御 (U+202A-U+202E、U+2066-U+2069)、BOM (U+FEFF)。最後のものは、画面で
 * 並びを入れ替えたり、見えない文字で別の値に見せかけたりできる。
 */
function isDisallowedInSingleLine(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * 改行・制御文字・不可視の書式文字を含まない 1 行の文字列か。題名・本文にそのまま入る欄
 * (source・catalogSlug・版の文字列・プロジェクト名) と見送りの理由は、HTTP の入口でこれを
 * 満たさないものを 400 にする (行を足して見出しやリンクを紛れ込ませる経路を作らない)。
 * 1 行でもリンク・@メンション・#参照・<img> は書ける。インラインの Markdown のエスケープは
 * 公開本文を組む bdboard-4y8q.2 の仕事で、ここは行の数と見えない文字だけを見る。
 */
export function isSingleLineText(value: string): boolean {
  for (const char of value) {
    if (isDisallowedInSingleLine(char.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

/**
 * 利用者のホーム配下の絶対パス ("/Users/<name>/"、"/home/<name>/"、"X:\Users\<name>\") を "~/" に
 * 畳む。source (B/C の出どころ) と catalogSlug は題名・本文・指紋・トンネル向けの応答にそのまま出るので、
 * フックが自分の "$0" を source に入れて報告しても、ユーザー名が下書きに残らない。指紋の前に使うので、
 * 別の利用者・別の PC の同じフックが 1 件にまとまる。"GET /api/home/x/" のような API のパスは
 * 前が空白・引用符・"=" ":" "("・"file://" でないので触らない。パス以外の秘密 (引数のトークンなど) は見つけない。
 */
// Windows のドライブ配下は大文字小文字を区別しない ("c:\users\…")。POSIX 側は区別する
// ("GET /users/42" のような API のパスを巻き込まないため)。
const HOME_PATH_PATTERN =
  /(?<=^|[\s'"=:(]|file:\/\/)(?:[A-Za-z]:[\\/]+[Uu][Ss][Ee][Rr][Ss][\\/]+[^\\/'"]+|\/(?:Users|home)[\\/]+[^\\/\s'"]+)(?:[\\/]+|$)/g;

export function canonicalizeIdentifier(value: string): string {
  return value.trim().replace(HOME_PATH_PATTERN, '~/');
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
