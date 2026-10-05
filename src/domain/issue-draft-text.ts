import { isMassOccurrenceFingerprint, ISSUE_DRAFT_MAX_FOLDED_FINGERPRINTS, type DraftEnvInfo, type DraftKind, type IssueDraft } from './issue-draft.js';

/**
 * 下書きの題名・本文の暫定版 (bdboard-4y8q.1)。
 *
 * 本物の組み立てと置き換え (設計 5節の buildPublicIssueBody、bdboard-4y8q.2) はまだ無いので、
 * ここでは固定の項目だけから作る: 規則・スクリプトの名前、版、回数、時刻。症状・原因・エラー文・
 * プロジェクト名は入力の型にそもそも受け口が無く、本文に紛れ込む経路が無い。それらは localOnly
 * (手元の情報) にあり、4y8q.2 が置き換えを通して本文へ入れる。4y8q.2 が入ったらこのファイルの
 * 呼び出しを差し替える。
 *
 * ただし名前 (source・catalogSlug) と版の文字列は、呼び出し側が渡した値がそのまま入る。
 * このファイルは中身を検査しない。1 行であること (改行・制御文字・不可視の書式文字なし) は HTTP の
 * 入口が 400 で保証し (issue-report-routes.ts、isSingleLineText)、ホーム配下の絶対パスは受け取りの
 * 時点で "~/" に畳んでいる (canonicalizeReceiveInput)。トンネルの読み手への応答でも同じ畳み込みを
 * もう一度かける (issue-report-dto.ts、foldHomePaths)。畳むのはホーム配下の絶対パスの決まった形だけ
 * (issue-draft-identifier.ts の foldHomePaths に一覧) で、それ以外の置き換え (エラー文・トークン・
 * リポジトリの内側の相対パスなど) と Markdown のエスケープは 4y8q.2 の仕事。
 */

const KIND_LABEL: Readonly<Record<DraftKind, string>> = {
  A: '作業の進め方',
  B: 'hook・配布スクリプト',
  C: 'bdboard 本体',
};

export interface ProvisionalTextInput {
  readonly kind: DraftKind;
  /** A のみ。 */
  readonly catalogSlug?: string;
  /** B/C の出どころ。 */
  readonly source?: string;
  readonly versions: DraftEnvInfo;
  readonly occurrenceCount: number;
  readonly firstOccurredAt: string;
  readonly lastOccurredAt: string;
}

export interface DraftText {
  readonly title: string;
  readonly body: string;
}

/**
 * 下書きの今の状態 (回数・時刻・版・名前) から自動で組む題名・本文。受け取りが「直していない欄」を作り直すとき
 * (issue-draft-build.ts の finalize) と、PATCH で空にされた欄を自動の値へ戻すとき (issue-draft-edit.ts) の共通の入口 (bdboard-pnvj)。
 * 名前は下書きが持っている source / catalogSlug を使う (指紋から切り出し直さない)。
 */
export function autoTextOf(draft: IssueDraft): DraftText {
  if (isMassOccurrenceFingerprint(draft.fingerprint)) {
    const folded = draft.localOnly.foldedFingerprints ?? [];
    return buildMassOccurrenceText({
      kind: draft.kind,
      bucket: draft.fingerprint.slice(draft.fingerprint.lastIndexOf(':') + 1),
      foldedCount: folded.length,
      foldedCountCapped: folded.length >= ISSUE_DRAFT_MAX_FOLDED_FINGERPRINTS,
      occurrenceCount: draft.occurrenceCount,
      firstOccurredAt: draft.firstOccurredAt,
      lastOccurredAt: draft.lastOccurredAt,
    });
  }
  return buildProvisionalDraftText({
    kind: draft.kind,
    ...(draft.catalogSlug !== undefined ? { catalogSlug: draft.catalogSlug } : {}),
    ...(draft.source !== undefined ? { source: draft.source } : {}),
    versions: draft.localOnly.envInfo,
    occurrenceCount: draft.occurrenceCount,
    firstOccurredAt: draft.firstOccurredAt,
    lastOccurredAt: draft.lastOccurredAt,
  });
}

export function buildProvisionalDraftText(input: ProvisionalTextInput): DraftText {
  const name = input.kind === 'A' ? (input.catalogSlug ?? '') : (input.source ?? '');
  const lines = [
    `種類: ${KIND_LABEL[input.kind]}`,
    `対象: ${name}`,
    `発生回数: ${input.occurrenceCount}`,
    `最初に起きた時刻: ${input.firstOccurredAt}`,
    `最後に起きた時刻: ${input.lastOccurredAt}`,
    '',
    '版:',
    `- bdboard: ${input.versions.bdboardVersion}`,
    ...(input.versions.harnessVersion !== undefined ? [`- ハーネス: ${input.versions.harnessVersion}`] : []),
    `- OS: ${input.versions.os}`,
    `- Node: ${input.versions.nodeVersion}`,
    ...(input.versions.bdVersion !== undefined ? [`- bd: ${input.versions.bdVersion}`] : []),
    ...(input.versions.ghVersion !== undefined ? [`- gh: ${input.versions.ghVersion}`] : []),
    '',
    '(症状・原因・エラー文は、公開本文の組み立てが入るまでこの本文に含めていません。手元の情報にあります。)',
  ];
  return { title: `[${KIND_LABEL[input.kind]}] ${name}`, body: lines.join('\n') };
}

export interface MassOccurrenceTextInput {
  readonly kind: DraftKind;
  /** hourBucketOf の値 (例: "2026-10-04T12")。 */
  readonly bucket: string;
  /** 丸め込まれた、互いに別の指紋の数。 */
  readonly foldedCount: number;
  /** foldedCount が記録の上限に達していて、実際はそれ以上かもしれない。 */
  readonly foldedCountCapped: boolean;
  readonly occurrenceCount: number;
  readonly firstOccurredAt: string;
  readonly lastOccurredAt: string;
}

/** 設計 4節: 公開本文は一般的な文面に留め、個別の詳細は出さない。 */
export function buildMassOccurrenceText(input: MassOccurrenceTextInput): DraftText {
  const distinct = input.foldedCountCapped ? `${input.foldedCount} 件以上` : `${input.foldedCount} 件`;
  const lines = [
    `種類: ${KIND_LABEL[input.kind]}`,
    `時間帯 (UTC): ${input.bucket}`,
    `この時間に ${distinct}の類似しない問題が集中発生しました。`,
    `発生回数の合計: ${input.occurrenceCount}`,
    `最初に起きた時刻: ${input.firstOccurredAt}`,
    `最後に起きた時刻: ${input.lastOccurredAt}`,
    '',
    '(個別の詳細は手元の情報にあります。)',
  ];
  return { title: `[大量発生] ${KIND_LABEL[input.kind]} (${input.bucket})`, body: lines.join('\n') };
}
