import type { IssueDraftStatus, IssueDraftSuspectedLeakDto } from '../../api/issue-reports';

/**
 * 不具合報告タブ (bdboard-4y8q.3.2) の表示用の純粋関数。サーバーの値をそのまま信じず、
 * 知らない種類・範囲外の位置・欠けた欄でも落ちずに汎用の表示へ倒す。
 */

const KIND_LABELS: Readonly<Record<string, string>> = {
  A: '作業の進め方',
  B: 'hook・配布スクリプト',
  C: 'bdboard 本体',
};

export function draftKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? `種類 ${kind}`;
}

export const DRAFT_STATUS_ORDER: readonly IssueDraftStatus[] = ['pending', 'posted', 'dismissed'];

const STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: '未処理',
  posted: '投稿済み',
  dismissed: '見送り',
};

export function draftStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

const LEAK_KIND_LABELS: Readonly<Record<string, string>> = {
  'project-path': 'プロジェクトのパス',
  'home-path': 'ホームのパス',
  project: 'プロジェクト名',
  user: 'ユーザー名',
  host: 'ホスト名',
  branch: 'ブランチ名',
  token: 'トークンらしい文字列',
  'key-block': '秘密鍵',
  email: 'メールアドレス',
};

/** 位置の無い疑い: 手元の鍵 (名前) が上限を超えて、一部を探していない。 */
export const KEY_OVERFLOW_LEAK_KIND = 'key-overflow';

/** 知らない種類はサーバーの値を短く添えた汎用の表示にする (未知の kind で落とさない)。 */
export function leakKindLabel(kind: string): string {
  if (kind === KEY_OVERFLOW_LEAK_KIND) return '探しきれていない名前';
  const known = LEAK_KIND_LABELS[kind];
  if (known !== undefined) return known;
  const shown = kind.length > 40 ? `${kind.slice(0, 40)}…` : kind;
  return `その他の疑い (${shown})`;
}

export interface LeakItem {
  readonly key: string;
  readonly fieldLabel: string;
  readonly label: string;
  /** 該当する文字列。位置が無い・範囲外のときは undefined。 */
  readonly excerpt: string | undefined;
}

function validRange(text: string, start: unknown, end: unknown): boolean {
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    (start as number) >= 0 &&
    (start as number) < (end as number) &&
    (end as number) <= text.length
  );
}

/** 疑いの一覧を表示用に組む。位置はサーバーが返した題名・本文 (保存済みの文字列) の位置。 */
export function describeLeaks(
  saved: { readonly title: string; readonly body: string },
  leaks: readonly IssueDraftSuspectedLeakDto[] | undefined,
): LeakItem[] {
  if (leaks === undefined) return [];
  return leaks.map((leak, index) => {
    const text = leak.field === 'title' ? saved.title : saved.body;
    const kind = typeof leak.kind === 'string' ? leak.kind : String(leak.kind);
    const positioned = kind !== KEY_OVERFLOW_LEAK_KIND && validRange(text, leak.start, leak.end);
    const excerpt = positioned ? text.slice(leak.start, leak.end) : undefined;
    return {
      key: `${index}-${leak.field}-${kind}-${String(leak.start)}`,
      fieldLabel: leak.field === 'title' ? '題名' : '本文',
      label: leakKindLabel(kind),
      excerpt: excerpt !== undefined && excerpt.length > 120 ? `${excerpt.slice(0, 120)}…` : excerpt,
    };
  });
}

/**
 * 上限で省いた疑いの数。サーバーは数を返すが、真偽値や壊れた値でも落とさない。
 * 'some' は数が分からないが省いたことだけ分かる場合。
 */
export function omittedLeakCount(value: unknown): number | 'some' {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (value === true) return 'some';
  return 0;
}

/** 公開本文の置き換えが書く印 (docs/ISSUE-REPORTING.md 5節)。表示で目印を付けるだけで、意味は変えない。 */
const REDACTION_PLACEHOLDERS = [
  '<redacted-key-block>',
  '<redacted-token>',
  '<project>',
  '<user>',
  '<host>',
  '<branch>',
  '<email>',
  '~/',
] as const;

export type SegmentMark = 'none' | 'redaction' | 'leak';

export interface TextSegment {
  readonly text: string;
  readonly mark: SegmentMark;
}

/**
 * 生の文字列を、置き換えた印・置き換え漏れの疑いの範囲で区切る。疑いの範囲が置き換えの印より優先する。
 * 範囲外・壊れた位置の疑いは無視する (一覧のほうで位置なしとして出る)。
 */
export function segmentMarkedText(text: string, leakRanges: readonly { start: number; end: number }[]): TextSegment[] {
  const marks = new Uint8Array(text.length);
  for (const placeholder of REDACTION_PLACEHOLDERS) {
    let from = text.indexOf(placeholder);
    while (from !== -1) {
      marks.fill(1, from, from + placeholder.length);
      from = text.indexOf(placeholder, from + placeholder.length);
    }
  }
  for (const range of leakRanges) {
    if (validRange(text, range.start, range.end)) marks.fill(2, range.start, range.end);
  }
  const segments: TextSegment[] = [];
  let start = 0;
  for (let index = 1; index <= text.length; index += 1) {
    if (index === text.length || marks[index] !== marks[start]) {
      const code = marks[start];
      segments.push({ text: text.slice(start, index), mark: code === 2 ? 'leak' : code === 1 ? 'redaction' : 'none' });
      start = index;
    }
  }
  return segments;
}

export type VersionComparison =
  | { readonly kind: 'same'; readonly occurred: string; readonly latest: string }
  | { readonly kind: 'different'; readonly occurred: string; readonly latest: string }
  | { readonly kind: 'unknown-occurrence'; readonly latest: string | undefined }
  | { readonly kind: 'unknown-latest'; readonly occurred: string };

function presentVersion(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** 注入先のハーネスの版 (発生時) と、この bdboard が配る最新の版を比べる。大小は見ず、同じか違うかだけ。 */
export function compareHarnessVersions(occurredRaw: string | null | undefined, latestRaw: string | null | undefined): VersionComparison {
  const occurred = presentVersion(occurredRaw);
  const latest = presentVersion(latestRaw);
  if (occurred === undefined) return { kind: 'unknown-occurrence', latest };
  if (latest === undefined) return { kind: 'unknown-latest', occurred };
  return occurred === latest ? { kind: 'same', occurred, latest } : { kind: 'different', occurred, latest };
}
