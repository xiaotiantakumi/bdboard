/**
 * 会話キーで索かれる Record ストアに対して、キー再割り当て(migrate)と
 * 一括削除(purge)を同一ポリシーで適用するための純粋関数群。
 *
 * ChatPanel 内の複数ストア(conversationInputs / conversationAttachments /
 * attachmentErrors / threadModelIds / draftSeedTextRef)は、会話キーが変わるたびに
 * 同じ移送規則で移し替える必要がある。呼び出しサイトごとに手書きすると
 * 1 ストアだけ書き忘れる desync 事故の温床になるため、ここに単一実装を置く。
 */

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
