import type { DraftEnvInfo, DraftKind } from './issue-draft.js';

/**
 * 下書きの題名・本文の暫定版 (bdboard-4y8q.1)。
 *
 * 本物の組み立てと置き換え (設計 5節の buildPublicIssueBody、bdboard-4y8q.2) はまだ無いので、
 * ここでは「公開してよい固定項目」だけから作る: 規則・スクリプトの名前、版、回数、時刻。
 * 症状・原因・エラー文・パス・プロジェクト名は入力の型にそもそも受け口が無く、本文に
 * 紛れ込む経路が無い。それらは localOnly (手元の情報) にあり、4y8q.2 が置き換えを通して
 * 本文へ入れる。4y8q.2 が入ったらこのファイルの呼び出しを差し替える。
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
