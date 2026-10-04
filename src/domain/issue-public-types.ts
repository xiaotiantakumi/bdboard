/**
 * 公開 issue の題名・本文の組み立て (bdboard-4y8q.2、docs/ISSUE-REPORTING.md 5節) の入出力の型。
 *
 * 型の分離が防ぐもの: 公開本文の元になる入力 (PublicBuildInput) と、公開してはいけない手元だけの鍵 (LocalOnlyKeys) を
 * 別の型・別の引数にして、「注入先のプロジェクト名とリポジトリの URL・ブランチ名・チケットの ID と本文・注入先のコード・
 * 環境変数の値」が公開本文に入る道を作らない。PublicBuildInput にはそれらの欄が無い。IssueDraft や LocalOnlyContext
 * そのものを渡す形も、NoExtraKeys で型エラーにする。ただし、症状・原因・エラー文などの自由記述は意図して入力に含まれ、
 * そこに残る固有名詞・秘密を取り除くのは型ではなく置換の規則 (issue-public-redact.ts) と最後の網である。
 */
import type { DraftEnvInfo, DraftKind } from './issue-draft.js';

/** 公開本文に(置換したうえで)載せてよい欄。この欄だけを名前で読み、欄の列挙やスプレッドはしない。 */
export interface PublicBuildInput {
  readonly kind: DraftKind;
  /** A のみ: failure-catalog の短い名前。 */
  readonly catalogSlug?: string;
  /** B/C: hook・スクリプトの名前 (出どころ)。 */
  readonly source?: string;
  readonly symptom?: string;
  readonly cause?: string;
  readonly prevention?: string;
  /** 切り詰め前の生ログ全文。全文を置換してから先頭 1000・末尾 1000 コードポイントに切る。 */
  readonly errorText?: string;
  /** 人・エージェントが書いた説明。ほかの自由記述と同じ処理を通す。 */
  readonly agentNote?: string;
  readonly versions: DraftEnvInfo;
  readonly occurrenceCount: number;
  readonly firstOccurredAt: string;
  readonly lastOccurredAt: string;
}

export type ProperNounCategory = 'project' | 'user' | 'host' | 'branch';

export interface LocalProperNoun {
  readonly category: ProperNounCategory;
  readonly value: string;
}

/**
 * 手元だけの鍵。公開本文に出してはいけない値で、探す文字列としてだけ使う (出力の材料にしない)。
 * projectRoots: プロジェクトの根の絶対パス (区切りは / \ \\ のどれでもよい)。
 */
export interface LocalOnlyKeys {
  readonly projectRoots: readonly string[];
  readonly properNouns: readonly LocalProperNoun[];
}

export type RedactionKind = 'project-path' | 'home-path' | ProperNounCategory | 'token' | 'key-block' | 'email';
export type PublicField = 'title' | 'body';

/**
 * 置き換えた箇所。start/end は最終の title / body 文字列への UTF-16 コード単位のオフセット (半開区間 [start, end))。
 * 範囲は出力に書いた印の文字列 (`<redacted-token>`・`~/` など) を覆う。元の文字列の位置ではない。
 */
export interface RedactionMark {
  readonly field: PublicField;
  readonly kind: RedactionKind;
  readonly start: number;
  readonly end: number;
}

/** 置き換え漏れの疑い。位置は RedactionMark と同じ (最終文字列の UTF-16 オフセット)。matched は最終文字列の切り出し。 */
export interface SuspectedLeak {
  readonly field: PublicField;
  readonly kind: RedactionKind;
  readonly start: number;
  readonly end: number;
  readonly matched: string;
}

export interface PublicBuildResult {
  readonly title: string;
  readonly body: string;
  readonly redactions: readonly RedactionMark[];
  readonly suspectedLeaks: readonly SuspectedLeak[];
}

/**
 * Shape に無いキーを持つ型を、新鮮なオブジェクトリテラルでなくても (変数に入れた IssueDraft などでも) 拒む。
 * 余分なキーの値の型を never にするので、渡した側がコンパイルエラーになる。
 */
export type NoExtraKeys<Shape, Actual extends Shape> = Actual &
  Record<Exclude<keyof Actual, keyof Shape>, never>;
