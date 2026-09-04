/**
 * 会話キーで索かれる Record ストアに対して、キー再割り当て(migrate)と
 * 一括削除(purge)を同一ポリシーで適用するための純粋関数群。
 *
 * ChatPanel 内の複数ストア(conversationInputs / conversationAttachments /
 * attachmentErrors / threadModelIds / draftSeedTextRef)は、会話キーが変わるたびに
 * 同じ移送規則で移し替える必要がある。呼び出しサイトごとに手書きすると
 * 1 ストアだけ書き忘れる desync 事故の温床になるため、ここに単一実装を置く。
 *
 * bdboard-ru4d: 会話キー付き「ドラフト積載物」5ストアの名前集合と、再割り当て
 * サイトごとの引き継ぎ選択(網羅性を型で強制)もここで定義する。
 */

/** 会話キー付きドラフト積載物ストアの正本一覧(bdboard-ru4d)。 */
export const DRAFT_PAYLOAD_STORE_NAMES = [
  'conversationInputs',
  'conversationAttachments',
  'attachmentErrors',
  'threadModelIds',
  'draftSeedText',
] as const;

export type DraftPayloadStoreName = (typeof DRAFT_PAYLOAD_STORE_NAMES)[number];

/** 再割り当てサイトごとの「引き継ぐ / 引き継がない」選択。 */
export type DraftPayloadStoreCarryDecision =
  | { readonly carry: true }
  | { readonly carry: false; readonly reason: string };

/** 5ストアすべてのキーを網羅した引き継ぎ選択プラン。 */
export type DraftPayloadStoreCarryPlan = {
  readonly [K in DraftPayloadStoreName]: DraftPayloadStoreCarryDecision;
};

/**
 * 網羅性を型で強制するためのヘルパー。ストアを1つ増やすと、
 * このプランを渡している全サイトでコンパイルエラーになる。
 */
export function defineDraftPayloadStoreCarryPlan<P extends DraftPayloadStoreCarryPlan>(
  plan: P,
): P {
  return plan;
}

/** 引き継ぎ選択プランの参照用(実行時に引き継ぐストアが無いサイト向け)。 */
export function referenceDraftPayloadStoreCarryPlan(
  plan: DraftPayloadStoreCarryPlan,
): DraftPayloadStoreCarryPlan {
  return plan;
}

type CarriedStoreNames<P extends DraftPayloadStoreCarryPlan> = {
  [K in DraftPayloadStoreName]: P[K]['carry'] extends true ? K : never;
}[DraftPayloadStoreName];

type NotCarriedStoreNames<P extends DraftPayloadStoreCarryPlan> = {
  [K in DraftPayloadStoreName]: P[K]['carry'] extends false ? K : never;
}[DraftPayloadStoreName];

export type DraftPayloadStoreCarryApplyFns<P extends DraftPayloadStoreCarryPlan> = {
  [K in CarriedStoreNames<P>]: () => void;
} & {
  [K in NotCarriedStoreNames<P>]?: never;
};

/**
 * carry: true のストアだけ applyByStore を実行する。applyByStore は
 * carry: true のストア名をすべて網羅していなければ型エラーになる。
 */
export function applyDraftPayloadStoreCarryPlan<P extends DraftPayloadStoreCarryPlan>(
  plan: P,
  applyByStore: DraftPayloadStoreCarryApplyFns<P>,
): void {
  // 交差型のため未解決ジェネリック P 下では applyByStore[storeName] が never に潰れる。
  // 呼び出し側の型 DraftPayloadStoreCarryApplyFns<P> はそのまま維持し、実装だけ緩い型へ落とす。
  const applicators = applyByStore as Partial<Record<DraftPayloadStoreName, () => void>>;
  for (const storeName of DRAFT_PAYLOAD_STORE_NAMES) {
    if (!plan[storeName].carry) continue;
    const apply = applicators[storeName];
    if (apply === undefined) {
      throw new Error(
        `applyDraftPayloadStoreCarryPlan: carry:true のストア ${storeName} に apply 関数がありません`,
      );
    }
    apply();
  }
}

/** 登録簿 applyToDraftPayloadStores 用: 各ストアへ transform を適用する関数。 */
export type DraftPayloadStoreTransform = <T>(
  record: Record<string, T>,
  isEmpty: (value: T) => boolean,
) => Record<string, T>;

export type DraftPayloadStoreApplicators = {
  readonly [K in DraftPayloadStoreName]: (
    transform: DraftPayloadStoreTransform,
  ) => void;
};

/**
 * 登録簿: 5ストアすべてに同一 transform を適用する。
 * applicators は DraftPayloadStoreName をすべて網羅していなければ型エラー。
 */
export function applyTransformToAllDraftPayloadStores(
  applicators: DraftPayloadStoreApplicators,
  transform: DraftPayloadStoreTransform,
): void {
  for (const storeName of DRAFT_PAYLOAD_STORE_NAMES) {
    applicators[storeName](transform);
  }
}

/**
 * 会話キーで索かれる Record から、`from` キーの中身を `to` キーへ移す。
 *
 * - 移送元が空(`isEmpty` が true)なら移送せず、`from` キーだけ消す
 * - 移送先に既に中身がある(`isEmpty` が false)なら上書きせず、`from` キーだけ消す
 * - いずれの場合も `from` キーは必ず消える
 * - 変化が無いときは同一参照を返す
 */
export function migrateKeyInRecord<T>(
  record: Record<string, T>,
  from: string,
  to: string,
  isEmpty: (value: T) => boolean,
): Record<string, T> {
  if (!(from in record)) return record;
  const { [from]: sourceValue, ...rest } = record;
  if (sourceValue === undefined || isEmpty(sourceValue)) return rest;
  const targetValue = rest[to];
  if (targetValue !== undefined && !isEmpty(targetValue)) return rest;
  return { ...rest, [to]: sourceValue };
}

/**
 * 述語に一致する全キーを取り除く。一致が無ければ同一参照を返す。
 */
export function purgeKeysInRecord<T>(
  record: Record<string, T>,
  matches: (key: string) => boolean,
): Record<string, T> {
  const staleKeys = Object.keys(record).filter(matches);
  if (staleKeys.length === 0) return record;
  const next = { ...record };
  for (const key of staleKeys) delete next[key];
  return next;
}

/** 「空文字も中身なし」とみなすストア用(conversationInputs)。 */
export const isEmptyText = (value: string): boolean => value === '';

/** 「空配列も中身なし」とみなすストア用(conversationAttachments)。 */
export const isEmptyList = <T>(value: readonly T[]): boolean => value.length === 0;

/** 「キーの有無だけが意味を持つ」ストア用(attachmentErrors / threadModelIds / draftSeedText)。 */
export const isNeverEmpty = (): boolean => false;
