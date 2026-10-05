import { ApiError } from '../../api/http';
import { refreshWaitSeconds, type ExternalIssueListDto, type ExternalTextChecks } from '../../api/issue-reports-external';
import { formatAbsoluteTime } from '../../formatAbsoluteTime';

/**
 * 「届いた issue」(bdboard-4y8q.9.5、docs/ISSUE-REPORTING.md 8節) の表示用の純粋関数。外部 I/O を持たない。
 * 題名・本文は第三者の文章なので、見えない文字は印に置き換え、HTML コメントは範囲を示して見せる (文字は 1 つも変えない)。
 */

/**
 * 見えない文字の集合。サーバーの検査 (src/domain/external-issue-hidden-text.ts の INVISIBLE_CHARS) と同じ範囲を、web が src を
 * import できないので二重に持つ。externalIssueText.test.ts がサーバーのソースを文字として読み、全コードポイントで一致を確かめる。
 */
export const INVISIBLE_CODE_POINT_RANGES: readonly (readonly [number, number])[] = [
  [0x200b, 0x200b],
  [0x200c, 0x200c],
  [0x200d, 0x200d],
  [0x2060, 0x2060],
  [0xfeff, 0xfeff],
  [0x202a, 0x202a],
  [0x202b, 0x202b],
  [0x202c, 0x202c],
  [0x202d, 0x202d],
  [0x202e, 0x202e],
  [0x2066, 0x2066],
  [0x2067, 0x2067],
  [0x2068, 0x2068],
  [0x2069, 0x2069],
  [0x061c, 0x061c],
  [0x200e, 0x200e],
  [0x200f, 0x200f],
  [0xe0000, 0xe007f],
];

export function isInvisibleCodePoint(codePoint: number): boolean {
  return INVISIBLE_CODE_POINT_RANGES.some(([first, last]) => codePoint >= first && codePoint <= last);
}

/** `⟦U+200B⟧` の形の印 (U+27E6 / U+27E7 で囲む。16 進は大文字・4 桁未満は 0 埋め。タグ文字は `⟦U+E0041⟧`)。 */
export function formatInvisibleMark(codePoint: number): string {
  return `⟦U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}⟧`;
}

export type InlineSegment =
  | { readonly kind: 'text'; readonly text: string }
  /** 見えない文字の連なり (種類をまたいで連続していれば 1 つ)。`marks` は印を連結した文字列。 */
  | { readonly kind: 'invisible'; readonly marks: string };

export type ExternalTextSegment =
  | InlineSegment
  | { readonly kind: 'comment'; readonly parts: readonly InlineSegment[]; readonly closed: boolean };

/** `text[from, to)` を、普通の文字と見えない文字の印に分ける (コードポイントで読むので、サロゲートの対を割らない)。 */
function splitInvisible(text: string, from: number, to: number): InlineSegment[] {
  const parts: InlineSegment[] = [];
  let plainStart = from;
  let marks = '';
  let index = from;
  while (index < to) {
    const codePoint = text.codePointAt(index) ?? 0;
    if (isInvisibleCodePoint(codePoint)) {
      if (marks === '' && index > plainStart) parts.push({ kind: 'text', text: text.slice(plainStart, index) });
      marks += formatInvisibleMark(codePoint);
    } else if (marks !== '') {
      parts.push({ kind: 'invisible', marks });
      marks = '';
      plainStart = index;
    }
    index += codePoint > 0xffff ? 2 : 1;
  }
  if (marks !== '') parts.push({ kind: 'invisible', marks });
  else if (plainStart < to) parts.push({ kind: 'text', text: text.slice(plainStart, to) });
  return parts;
}

/**
 * 題名・本文を、普通の文字 / 見えない文字の印 / HTML コメントに区切る。コメントは `<!--` から `-->` の末尾まで (閉じていなければ末尾まで)。
 * `-->` は開きの直後 (`<!--` の次) から探す (`<!-->` は自分の末尾では閉じない。サーバーの `findHtmlComments` と同じ)。
 * 線形時間 (indexOf は前に進むだけで、正規表現を使わない)。
 */
export function segmentExternalText(text: string): ExternalTextSegment[] {
  const segments: ExternalTextSegment[] = [];
  let cursor = 0;
  for (;;) {
    const open = text.indexOf('<!--', cursor);
    if (open < 0) break;
    segments.push(...splitInvisible(text, cursor, open));
    const close = text.indexOf('-->', open + 4);
    const end = close < 0 ? text.length : close + 3;
    segments.push({ kind: 'comment', parts: splitInvisible(text, open, end), closed: close >= 0 });
    cursor = end;
  }
  segments.push(...splitInvisible(text, cursor, text.length));
  return segments;
}

export interface CheckCount {
  readonly key: 'invisible' | 'comments' | 'encoded' | 'links';
  readonly label: string;
  readonly count: number;
  readonly detail?: string;
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

const INVISIBLE_KINDS_SHOWN = 5;

/** 機械の検査の結果を、ラベルと数にする。数だけを出し、判定の言葉は使わない (判断は 4y8q.10)。 */
export function describeCheckCounts(checks: ExternalTextChecks): CheckCount[] {
  const kinds = checks.invisibleChars.kinds;
  const kindDetails = kinds.slice(0, INVISIBLE_KINDS_SHOWN).map((kind) => `${kind.codePoint} ×${finite(kind.count)}`);
  if (kinds.length > INVISIBLE_KINDS_SHOWN) kindDetails.push(`ほか ${kinds.length - INVISIBLE_KINDS_SHOWN} 種類`);
  const links = checks.links;
  const linkDetail =
    `Markdown ${finite(links.markdownLinks)}・autolink ${finite(links.autolinks)}` +
    `・参照定義 ${finite(links.referenceDefinitions)}・生の URL ${finite(links.rawUrls)}`;
  return [
    {
      key: 'invisible',
      label: '見えない文字',
      count: finite(checks.invisibleChars.total),
      ...(kindDetails.length > 0 ? { detail: kindDetails.join('、') } : {}),
    },
    {
      key: 'comments',
      label: 'HTML コメント',
      count: finite(checks.htmlComments.count),
      ...(checks.htmlComments.unclosed ? { detail: '閉じていないものを含む' } : {}),
    },
    { key: 'encoded', label: '長い符号化文字列', count: finite(checks.longEncodedStrings.count) },
    { key: 'links', label: 'リンク', count: finite(links.total), detail: linkDetail },
  ];
}

/** gh の呼び出しの手元の上限に当たったときの detail の先頭 (サーバーの wire-external-issues.ts の GH_BUDGET_EXHAUSTED_MESSAGE)。分類にだけ使う。 */
export const BUDGET_EXHAUSTED_DETAIL_PREFIX = 'gh call limit reached';

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  'gh-missing': 'GitHub CLI (gh) が見つかりません。gh を入れると届いた issue を確かめられます。',
  'gh-unauthenticated': 'gh でログインしていません。ターミナルで gh auth login を実行してください。',
  'rate-limited': 'GitHub の問い合わせの制限に当たりました。しばらくしてから自動でやり直します。',
  failed: '確認に失敗しました。しばらくしてから自動でやり直します。',
  'bd-failed': 'bd の紐付けを読めませんでした。一覧は前回のままです。',
  'storage-failed': '写しの保存に失敗しました。一覧は前回のままです。',
  unexpected: '想定外の失敗で確認が止まりました。一覧は前回のままです。',
};

const BUDGET_EXHAUSTED_MESSAGE = 'GitHub への問い合わせの手元の上限に達しました。しばらくしてから確かめられます。';

/**
 * 一覧の状態の固定文。サーバーの `error.detail` は返さない (出すかどうかは呼び出し側が、読み手がローカルかで決める)。
 * 予算切れの `failed` だけは detail の先頭で見分けて「しばらくしてから」と言う (再開の時刻はサーバーが返さないので出さない)。
 */
export function externalStateMessage(list: ExternalIssueListDto): string {
  if (list.state === 'idle') return 'まだ確かめていません (起動の約 1 分後に最初の確認をします)。';
  if (list.state === 'ok') {
    const checkedAt = list.fetchedAt === null ? '' : `${formatAbsoluteTime(list.fetchedAt)} に確かめました。`;
    return list.issues.length === 0
      ? `${checkedAt}届いた issue はありません。`
      : `${checkedAt}届いた issue は ${list.issues.length} 件です。`;
  }
  const error = list.error;
  if (error === null) return '確認が止まりました。';
  if (error.kind === 'failed' && error.detail.startsWith(BUDGET_EXHAUSTED_DETAIL_PREFIX)) return BUDGET_EXHAUSTED_MESSAGE;
  return ERROR_MESSAGES[error.kind] ?? '確認が止まりました。';
}

/** 確認が止まっているとき、前回までの一覧がいつのものか。無ければ null。 */
export function externalStaleNote(list: ExternalIssueListDto): string | null {
  if (list.state !== 'error' || list.fetchedAt === null) return null;
  return `最後に確かめられたのは ${formatAbsoluteTime(list.fetchedAt)} です (一覧はそのときのものです)。`;
}

/** 「今すぐ確認」の失敗の文。429 は Retry-After の秒数 (本文の retryAfterSeconds) を出す。それ以外はサーバーの文言を出さず固定文。 */
export function refreshFailureMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) {
    const seconds = refreshWaitSeconds(error);
    return seconds === undefined
      ? '確認は 1 分に 1 回までです。しばらくしてからもう一度押してください。'
      : `確認は 1 分に 1 回までです。${seconds} 秒ほど待ってからもう一度押してください。`;
  }
  return '今すぐ確認できませんでした。しばらくしてからもう一度押してください。';
}
