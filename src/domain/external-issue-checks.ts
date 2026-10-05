/**
 * 届いた issue (ほかの人が出した公開 issue) の切り詰めと機械の検査 (bdboard-4y8q.9.1、docs/ISSUE-REPORTING.md 8節)。
 * IO を持たない純粋関数だけ。gh の呼び出し・保存・HTTP・画面は後続 (4y8q.9.2〜9.5)。
 *
 * 流れ: gh で読んだ生の題名・本文 → `truncateExternalIssue` (サーバー側の上限) → 切り詰めた文字列に `runMachineChecks`
 * → カードに出す。検査は数と位置だけを返し、「安全」「危険」の判断はしない (4y8q.9 の要求。判断は 4y8q.10)。
 */
import { codePointLength, cutCodePointsHead } from './issue-public-text.js';
import {
  findHtmlComments,
  findInvisibleChars,
  findLongEncodedStrings,
  type HtmlCommentCheck,
  type InvisibleCharCheck,
  type LongEncodedCheck,
} from './external-issue-hidden-text.js';
import { countLinks, type LinkCheck } from './external-issue-links.js';

export {
  LONG_ENCODED_MIN_LENGTH,
  MACHINE_CHECK_POSITION_LIMIT,
  type HtmlCommentCheck,
  type HtmlCommentSpan,
  type InvisibleCharCheck,
  type InvisibleCharGroup,
  type InvisibleCharKind,
  type LongEncodedCheck,
  type LongEncodedSpan,
} from './external-issue-hidden-text.js';
export type { LinkCheck } from './external-issue-links.js';

/** 題名の上限 (コードポイント。サロゲートの対は 1 と数える)。 */
export const EXTERNAL_ISSUE_TITLE_MAX = 300;
/** 本文の上限 (コードポイント)。 */
export const EXTERNAL_ISSUE_BODY_MAX = 20_000;
/** 本文を切ったときに末尾へ付ける文言 (改行で 1 行を分けて付ける)。 */
export const EXTERNAL_ISSUE_BODY_TRUNCATION_MARK = '(本文が長いため以降省略)';

export interface ExternalIssueText {
  readonly title: string;
  readonly body: string;
  /**
   * 上流で本文を先に切ったときの、切る前の本文の長さ (コードポイント)。4y8q.9.2 の gh は jq で本文を 20,001 文字に切って
   * 全長をこの名前で返すので、`truncateExternalIssue(raw)` にそのまま渡せば写しの全長 (`compareWithSnapshot`) が保たれる。
   * 無い・整数でない・`body` の長さより小さいときは `body` から数える。
   */
  readonly bodyLength?: number;
}

export interface TruncatedExternalIssue {
  /** 切り詰めた題名 (印は付けない)。 */
  readonly title: string;
  /** 切り詰めた本文。切ったときは末尾に改行と `EXTERNAL_ISSUE_BODY_TRUNCATION_MARK` が付く。 */
  readonly body: string;
  readonly titleTruncated: boolean;
  readonly bodyTruncated: boolean;
  /** 切る前の長さ (コードポイント)。写しとの比較 (`compareWithSnapshot`) で、切った先の変化を長さで拾うのに使う。 */
  readonly titleLength: number;
  readonly bodyLength: number;
}

function cutField(
  value: string,
  max: number,
  knownLength?: number,
): { readonly text: string; readonly length: number; readonly truncated: boolean } {
  const measured = codePointLength(value);
  const length = knownLength !== undefined && Number.isSafeInteger(knownLength) && knownLength > measured ? knownLength : measured;
  if (length <= max) return { text: value, length, truncated: false };
  // コードポイントで数えて切るので、サロゲートの対の途中では切れない (issue-public-text.ts。4y8q.13 の教訓)。
  return { text: cutCodePointsHead(value, max), length, truncated: true };
}

/**
 * 題名は 300、本文は 20,000 コードポイントまでに切る。上限ちょうどはそのまま (切らない)。
 * 上限はコスト・処理時間の制御が目的で、セキュリティの境界ではない (8節)。
 */
export function truncateExternalIssue(issue: ExternalIssueText): TruncatedExternalIssue {
  const title = cutField(issue.title, EXTERNAL_ISSUE_TITLE_MAX);
  const body = cutField(issue.body, EXTERNAL_ISSUE_BODY_MAX, issue.bodyLength);
  return {
    title: title.text,
    body: body.truncated ? `${body.text}\n${EXTERNAL_ISSUE_BODY_TRUNCATION_MARK}` : body.text,
    titleTruncated: title.truncated,
    bodyTruncated: body.truncated,
    titleLength: title.length,
    bodyLength: body.length,
  };
}

/** 1 つの文字列 (題名か本文) にかけた検査の結果。判断の欄 (安全・危険など) は作らない。 */
export interface TextChecks {
  readonly invisibleChars: InvisibleCharCheck;
  readonly htmlComments: HtmlCommentCheck;
  readonly longEncodedStrings: LongEncodedCheck;
  readonly links: LinkCheck;
}

export interface MachineCheckResult {
  readonly title: TextChecks;
  readonly body: TextChecks;
}

function checkText(text: string): TextChecks {
  return {
    invisibleChars: findInvisibleChars(text),
    htmlComments: findHtmlComments(text),
    longEncodedStrings: findLongEncodedStrings(text),
    links: countLinks(text),
  };
}

/**
 * 題名と本文の両方に同じ検査をかける。`runMachineChecks(truncateExternalIssue(raw))` と書ける (題名と本文以外の欄は見ない)。
 * 位置は、それぞれ渡した文字列への UTF-16 のオフセット。
 */
export function runMachineChecks(issue: Pick<ExternalIssueText, 'title' | 'body'>): MachineCheckResult {
  return { title: checkText(issue.title), body: checkText(issue.body) };
}
