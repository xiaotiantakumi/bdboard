/**
 * 公開 issue の題名・本文を、決まった項目だけから組み立てる (bdboard-4y8q.2、docs/ISSUE-REPORTING.md 5節)。
 * domain 層の純粋関数 (ファイル・通信・時刻・乱数を使わない)。
 *
 * 型の分離: 公開本文の元 (PublicBuildInput) と、手元だけの鍵 (LocalOnlyKeys: プロジェクトの根・固有名詞) は別の型・別の引数。
 * 前者の名前付きの欄だけを読み (スプレッドや欄の列挙はしない)、後者は探す文字列としてだけ使う。NoExtraKeys で、IssueDraft のように
 * 余分な欄を持つ型は渡せない。注入先のプロジェクト名・リポジトリの URL・ブランチ名・チケットの ID と本文・注入先のコード・環境変数の値は、
 * 入力の型に欄が無いので、本文に入る道が無い (ただし自由記述の中に書かれていた分は、下の置換で取り除く)。
 *
 * コードの外に出る文字: 動的な文字列はすべて codeSpan (1 行) か codeBlock (複数行) を通してだけ出力へ入る
 * (issue-public-markdown.ts。リンク・@mention・#123 の参照・<img>・見出しが働かない)。コードの外にあるのは、このファイルの
 * 固定の見出し・ラベルと、数字 (Number.isSafeInteger を通した回数。そうでなければ "?") だけ。
 *
 * 処理の順序 (動的な文字列ごと):
 *   (0) 孤立サロゲートの除去 → 行・不可視文字の整形 (1 行の値は 1 行にする) — issue-public-text.ts
 *   (1) 同じ整形後の文字列に全 finder をかけて一致を集め、重なりを統合し、印に置き換える。置き換えの結果にもう一度
 *       (最大 2 回) かけて、印に替わったことで新しく現れた一致 ("<project>sk-…") も置き換える — issue-public-redact.ts
 *   (2) 置換「後」にコードポイント単位で省略する (先に切ると、切れ目でトークンが半分になって形に一致しなくなる)
 *   (3) code context で包み、固定の文言と並べる。印の位置は組み立ての場所で最終の title / body の位置へずらす
 *   (4) 最後の網: 完成した title と body に detectSuspectedLeaks をかけ直す。(0)〜(3) とは独立 — issue-public-leaks.ts
 *
 * 意図して扱わないもの: 未知の形の秘密 (パスワード・独自の API キー)、全角 (NFKC) や同形異字で書き換えた固有名詞、
 * ドットの無いメール ("user@host")、CJK の文章に埋まった 2〜3 文字の名前、分割された名前、Turkish の大文字小文字、
 * 画像、文脈から分かる機密性 (docs/ISSUE-REPORTING.md 5節「カバーしないもの」)。固有名詞でも 2〜3 文字のものは置換せず、
 * 単語として現れたときに検出だけする (issue-public-keys.ts)。鍵が上限を超えたときは keysTruncated と 'key-overflow' で知らせる。
 * 固定の文言 (「bdboard 本体」など) が固有名詞に当たれば、最後の網が疑いとして出す (過検出。人が見る)。
 * これは best-effort の機械処理であり、唯一の防御ではない。投稿の前に人が見ることが本来の防御。
 */
import type { DraftKind } from './issue-draft.js';
import { prepareKeys, type PreparedKeys } from './issue-public-keys.js';
import { detectSuspectedLeaks } from './issue-public-leaks.js';
import { codeBlock, codeSpan, type MarkdownPiece } from './issue-public-markdown.js';
import { elide, redactText } from './issue-public-redact.js';
import { findLeakSpans } from './issue-public-spans.js';
import { normalizeBlock, normalizeInline } from './issue-public-text.js';
import type {
  LocalOnlyKeys,
  NoExtraKeys,
  PublicBuildInput,
  PublicBuildResult,
  PublicField,
  RedactionMark,
  SuspectedLeak,
} from './issue-public-types.js';

const KIND_LABEL: Readonly<Record<DraftKind, string>> = {
  A: '作業の進め方',
  B: 'hook・配布スクリプト',
  C: 'bdboard 本体',
};

/** 欄ごとの上限 (コードポイント)。置換の「後」に切る。 */
const CAP = { titleName: 80, name: 120, time: 40, version: 80, freeText: 8000, errorEdge: 1000 } as const;

interface Composer {
  /** 固定の文言 (このファイルのリテラルだけ) を足す。 */
  readonly appendStatic: (value: string) => void;
  /** code context で包み終えた動的な値を足す。印は最終の位置へずらす。 */
  readonly appendDynamic: (piece: MarkdownPiece) => void;
  readonly finish: () => { readonly text: string; readonly marks: readonly RedactionMark[] };
}

function createComposer(field: PublicField): Composer {
  let text = '';
  const marks: RedactionMark[] = [];
  return {
    appendStatic(value) {
      text += value;
    },
    appendDynamic(piece) {
      const offset = text.length;
      text += piece.text;
      for (const mark of piece.marks) {
        marks.push({ ...mark, field, start: mark.start + offset, end: mark.end + offset });
      }
    },
    finish: () => ({ text, marks }),
  };
}

/** 実行時に文字列でない値 (型の外から来た欄) は無いものとして扱う。文字列化はしない。 */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * 省略の切れ目を落とさない範囲: 置換の後でも最後の網が報告するはずの一致 (置き換えなかった緩い一致など)。省略前の全文で探し、
 * 切れ目がその内側に落ちるなら範囲ごと省略側へ寄せる (切れ目で報告できない短い断片にしない)。省略するときだけ探す。
 */
function avoidingLeaks(prepared: PreparedKeys): (text: string) => readonly { start: number; end: number }[] {
  return (text) => findLeakSpans(text, prepared);
}

function inline(value: string, cap: number, prepared: PreparedKeys): MarkdownPiece {
  const normalized = normalizeInline(value);
  return codeSpan(elide(redactText(normalized, prepared), cap, 0, () => '…', avoidingLeaks(prepared)));
}

function block(value: string | undefined, prepared: PreparedKeys): MarkdownPiece | undefined {
  const normalized = normalizeBlock(textOf(value) ?? '');
  if (normalized === '') return undefined;
  const label = (count: number): string => `…(以降 ${String(count)} 文字省略)`;
  return codeBlock(elide(redactText(normalized, prepared), CAP.freeText, 0, label, avoidingLeaks(prepared)));
}

/** エラー全文: 全文を置換してから、先頭と末尾の 1000 コードポイントに省略する (順序を逆にしない)。 */
function errorBlock(value: string | undefined, prepared: PreparedKeys): MarkdownPiece | undefined {
  const normalized = normalizeBlock(textOf(value) ?? '');
  if (normalized === '') return undefined;
  const label = (count: number): string => `…(${String(count)} 文字省略)…`;
  return codeBlock(elide(redactText(normalized, prepared), CAP.errorEdge, CAP.errorEdge, label, avoidingLeaks(prepared)));
}

function appendSection(composer: Composer, heading: string, piece: MarkdownPiece | undefined): void {
  if (piece === undefined) return;
  composer.appendStatic(`\n## ${heading}\n`);
  composer.appendDynamic(piece);
  composer.appendStatic('\n');
}

/** 動的な 1 行の値を足す。整形後に空なら、空のコードスパンを出さず (GitHub では記号がそのまま見える)、固定の語を足す。 */
function appendInline(composer: Composer, value: string, cap: number, prepared: PreparedKeys): void {
  if (normalizeInline(value) === '') composer.appendStatic('(なし)');
  else composer.appendDynamic(inline(value, cap, prepared));
}

function appendVersion(composer: Composer, label: string, value: string | undefined, prepared: PreparedKeys): void {
  const text = textOf(value);
  if (text === undefined) return;
  composer.appendStatic(`- ${label}: `);
  appendInline(composer, text, CAP.version, prepared);
  composer.appendStatic('\n');
}

function appendTime(composer: Composer, label: string, value: string, prepared: PreparedKeys): void {
  composer.appendStatic(`${label}: `);
  appendInline(composer, textOf(value) ?? '', CAP.time, prepared);
  composer.appendStatic('\n');
}

function kindLabelOf(kind: DraftKind): string {
  return Object.hasOwn(KIND_LABEL, kind) ? KIND_LABEL[kind] : '不明';
}

function nameOf(input: PublicBuildInput): string {
  return textOf(input.kind === 'A' ? input.catalogSlug : input.source) ?? '';
}

export function buildPublicIssueBody<I extends PublicBuildInput>(
  input: NoExtraKeys<PublicBuildInput, I>,
  keys: LocalOnlyKeys,
): PublicBuildResult {
  const prepared = prepareKeys(keys);
  const kindLabel = kindLabelOf(input.kind);
  const name = nameOf(input);
  const hasName = normalizeInline(name) !== '';

  const titleComposer = createComposer('title');
  titleComposer.appendStatic(`[${kindLabel}] `);
  if (hasName) titleComposer.appendDynamic(inline(name, CAP.titleName, prepared));
  else titleComposer.appendStatic('(名称なし)');
  const title = titleComposer.finish();

  const count = Number.isSafeInteger(input.occurrenceCount) ? String(input.occurrenceCount) : '?';
  const bodyComposer = createComposer('body');
  bodyComposer.appendStatic(`## 概要\n- 種類: ${kindLabel}\n`);
  if (hasName) {
    bodyComposer.appendStatic('- 対象: ');
    bodyComposer.appendDynamic(inline(name, CAP.name, prepared));
    bodyComposer.appendStatic('\n');
  }
  bodyComposer.appendStatic(`- 発生回数: ${count}\n`);
  appendTime(bodyComposer, '- 最初に起きた時刻', input.firstOccurredAt, prepared);
  appendTime(bodyComposer, '- 最後に起きた時刻', input.lastOccurredAt, prepared);

  appendSection(bodyComposer, '症状', block(input.symptom, prepared));
  appendSection(bodyComposer, '原因', block(input.cause, prepared));
  appendSection(bodyComposer, '再発防止', block(input.prevention, prepared));
  appendSection(bodyComposer, 'エラー文', errorBlock(input.errorText, prepared));
  appendSection(bodyComposer, '説明', block(input.agentNote, prepared));

  bodyComposer.appendStatic('\n## 版\n');
  appendVersion(bodyComposer, 'bdboard', input.versions.bdboardVersion, prepared);
  appendVersion(bodyComposer, 'ハーネス', input.versions.harnessVersion, prepared);
  appendVersion(bodyComposer, 'OS', input.versions.os, prepared);
  appendVersion(bodyComposer, 'Node', input.versions.nodeVersion, prepared);
  appendVersion(bodyComposer, 'bd', input.versions.bdVersion, prepared);
  appendVersion(bodyComposer, 'gh', input.versions.ghVersion, prepared);
  const body = bodyComposer.finish();

  const redactions = [...title.marks, ...body.marks];
  // 鍵を探しきれていないときは、位置のない疑い 'key-overflow' を先頭に足す。「suspectedLeaks が空か」だけを見る呼び出し側も、
  // 鍵を落とした結果を「漏れなし」と読まない (失敗側に倒れる)。
  const overflow: SuspectedLeak[] = prepared.truncated
    ? [{ field: 'body', kind: 'key-overflow', start: 0, end: 0, matched: '' }]
    : [];
  const suspectedLeaks = [
    ...overflow,
    ...detectSuspectedLeaks('title', title.text, redactions, prepared),
    ...detectSuspectedLeaks('body', body.text, redactions, prepared),
  ];
  return { title: title.text, body: body.text, redactions, suspectedLeaks, keysTruncated: prepared.truncated };
}

export type { LocalOnlyKeys, PublicBuildInput, PublicBuildResult } from './issue-public-types.js';
export type { RedactedText, TextMark } from './issue-public-redact.js';
