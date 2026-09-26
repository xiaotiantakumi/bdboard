import {
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from 'react';
import { makeDraftKey } from './draftKey';
import { useLiveMirroredState } from './useLiveMirroredState';

export interface UseConversationKeyResult {
  selectedThreadIds: Record<string, string | undefined>;
  setSelectedThreadIds: Dispatch<SetStateAction<Record<string, string | undefined>>>;
  selectedThreadIdsRef: MutableRefObject<Record<string, string | undefined>>;
  draftNonces: Record<string, number>;
  setDraftNonces: Dispatch<SetStateAction<Record<string, number>>>;
  draftNoncesRef: MutableRefObject<Record<string, number>>;
  currentSessionId: string | undefined;
  currentConversationKey: string;
  currentConversationKeyRef: RefObject<string>;
}

function draftKeyFor(projectId: string, nonces: Record<string, number>): string {
  return makeDraftKey(projectId, nonces[projectId] ?? 0);
}

/**
 * bdboard-sso1.83 第10段: ChatPanel.tsx から会話キーの導出(selectedThreadIds/
 * draftNonces と、そこから計算する currentSessionId/currentConversationKey、
 * および各種 stale-closure 回避用の ref ミラー)を move-only で抜き出したもの。
 * effect は持たない(元々どれも useState/派生値の計算だけで、effect はここには
 * 無かった)。
 *
 * bdboard-33jm(root): selectedThreadIdsRef/draftNoncesRef は
 * 以前は「フック本体のトップレベルで `ref.current = state` する」render-mirror
 * だった(次の再レンダーまでしか追いつかず、書き込み側が個別に write site で
 * ref を同期する運用が必要だった。同じ種類のバグが7回再発した経緯は
 * useLiveMirroredState.ts のコメント参照)。今は useLiveMirroredState に
 * 一本化し、setSelectedThreadIds/setDraftNonces を呼ぶだけで ref.current が
 * 同期的に更新される(呼び出し側で個別に `xxxRef.current = ...` を書く必要は
 * 無くなった — 既存の書き込み箇所からその代入行は削除済み)。
 *
 * currentConversationKeyRef は他の2つと違い直接 setState されない派生値なので
 * useLiveMirroredState は使わない。代わりに(常に最新の)selectedThreadIdsRef/
 * draftNoncesRef から都度計算する getter にした — 代入する書き込み箇所が無いので
 * 「同期を書き忘れる」余地自体が無い。getter オブジェクト自身は
 * useState の遅延初期化で1回だけ作る(元の useRef と同じ「生存期間中 identity
 * 不変」を保つ — useCallback の依存配列にこれまでどおり安全に載せられる)。
 * selectedProjectId 自体は今回のスコープ外(このチケットが対象とするのは
 * selectedThreadIdsRef/draftNoncesRef/openThreadIdsRef/threadListsRef の
 * 同期漏れで、selectedProjectId の参照方式に既知のバグは無い)なので、
 * 元どおり render 時点の値を都度 ref へ写すだけにしてある。
 */
export function useConversationKey(selectedProjectId: string): UseConversationKeyResult {
  const {
    value: selectedThreadIds,
    ref: selectedThreadIdsRef,
    set: setSelectedThreadIds,
  } = useLiveMirroredState<Record<string, string | undefined>>({});
  const { value: draftNonces, ref: draftNoncesRef, set: setDraftNonces } = useLiveMirroredState<
    Record<string, number>
  >({});
  const currentSessionId = selectedThreadIds[selectedProjectId];
  const currentConversationKey = currentSessionId ?? draftKeyFor(selectedProjectId, draftNonces);

  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;

  const [currentConversationKeyRef] = useState<RefObject<string>>(() => ({
    get current() {
      const projectId = selectedProjectIdRef.current;
      return selectedThreadIdsRef.current[projectId] ?? draftKeyFor(projectId, draftNoncesRef.current);
    },
  }));

  return {
    selectedThreadIds,
    setSelectedThreadIds,
    selectedThreadIdsRef,
    draftNonces,
    setDraftNonces,
    draftNoncesRef,
    currentSessionId,
    currentConversationKey,
    currentConversationKeyRef,
  };
}
