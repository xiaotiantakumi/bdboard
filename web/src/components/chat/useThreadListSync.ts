import { useEffect } from 'react';
import { fetchChatThreads } from '../../api';
import { readPersistedChatThreads } from '../../chatThreadStorage';
import type { UseChatConversationsStateResult } from './useChatConversationsState';
import type { UseChatNotificationsResult } from './useChatNotifications';
import type { UseChatThreadListsResult } from './useChatThreadLists';
import type { UseConversationKeyResult } from './useConversationKey';
import type { useDraftThreadLauncher } from './useDraftThreadLauncher';

export interface UseThreadListSyncParams
  extends Pick<UseConversationKeyResult, 'draftNoncesRef' | 'selectedThreadIdsRef' | 'setSelectedThreadIds'>,
    Pick<UseChatConversationsStateResult, 'threadListRequestIdRef'>,
    Pick<UseChatThreadListsResult, 'setThreadLists' | 'setOpenThreadIds'>,
    Pick<UseChatNotificationsResult, 'setThreadError'>,
    Pick<
      ReturnType<typeof useDraftThreadLauncher>,
      'pendingPrefillRef' | 'pendingTicketDraftProjectRef' | 'startNewDraftThread'
    > {
  selectedProjectId: string;
}

/**
 * bdboard-sso1.83 第14d段: ChatPanel.tsx のスレッド一覧 effect(設計書 §1c の E7)を
 * 抜き出したもの。effect はこの1つだけで、ChatPanel では元の位置(コールド解決
 * effect E6 = useColdKeyspaceAdoption の直後、turn-status 回収 E8 より前)で呼ぶ。
 * 順序の理由: E9(ticket-context)より前に、本体の先頭で別プロジェクト宛の pending を
 * 無効化する(MF2/MF3)。E8 は generation>0 のとき、ここで ++ した
 * threadListRequestIdRef をさらに進める(設計書 §5 の P1)。
 *
 * ref の種類: pendingPrefillRef / pendingTicketDraftProjectRef は[正本]
 * (useDraftThreadLauncher が持つ)、threadListRequestIdRef は request-id、
 * draftNoncesRef / selectedThreadIdsRef は[render ミラー]。
 *
 * 依存配列: 再実行の契機は従来どおり selectedProjectId(と参照の変わらない
 * setThreadError)だけ。第14d段で exhaustive-deps が求める ref・setter・
 * startNewDraftThread を加えたが、どれも参照が変わらない(startNewDraftThread の
 * 依存は ref と setter と dispatch 由来の関数だけ)。startNewDraftThread の依存に
 * レンダーごとに変わる値を足すと、この effect が一覧を取り直すようになる
 * (ChatPanel.reassignment-characterization.test.tsx の 14d が検出する)。
 */
export function useThreadListSync({
  selectedProjectId,
  setThreadError,
  pendingPrefillRef,
  pendingTicketDraftProjectRef,
  threadListRequestIdRef,
  draftNoncesRef,
  selectedThreadIdsRef,
  setThreadLists,
  setOpenThreadIds,
  setSelectedThreadIds,
  startNewDraftThread,
}: UseThreadListSyncParams): void {
  useEffect(() => {
    if (selectedProjectId === '') return;
    // MF2/MF3: 別プロジェクト宛のまま残った pending 意図はここ(effect 本体の
    // 先頭)で無効化する。以前は cleanup 側で「この effect が担当していた
    // selectedProjectId 宛の pending だけ」を落としていたが、StrictMode の
    // 開発時ダブル実行(mount→destroy→mount)では destroy(cleanup) が
    // mount#2 の前に走ってしまい、「ユーザーがプロジェクトを離脱した」わけでも
    // ないのに mount#1 が立てた pending を消してしまっていた。mount#2 の
    // ticket-context effect は appliedTicketContextTokenRef の「適用済み」
    // ガードにより張り直さないため、結果として「チャットを開いた直後の主経路」
    // で pending が誰にも消化されず、既存スレッドが選択される回帰があった
    // (MF3、StrictMode で render を包んだ回帰テストで検出)。ここ(本体の
    // 先頭、selectedProjectId 変化のたびに必ず1回だけ実行される箇所)で
    // 「今の selectedProjectId 宛ではない pending」を無効化すれば、
    // StrictMode の疑似アンマウントでは selectedProjectId が変わらない
    // (同じプロジェクトへの mount→destroy→mount)ため誤って消されず、
    // 本当にプロジェクトが切り替わったとき(MF2 が意図した「離脱」)だけ
    // 正しく無効化される。
    if (
      pendingTicketDraftProjectRef.current !== null &&
      pendingTicketDraftProjectRef.current !== selectedProjectId
    ) {
      pendingTicketDraftProjectRef.current = null;
    }
    // pendingTicketDraftProjectRef と同じ理由での無効化。別プロジェクト宛の
    // まま残ったプリフィル文言の意図もここで一緒に無効化しないと、離脱後に
    // 同じプロジェクトへ戻って(ticketContext を介さず)手動で「新規スレッド」
    // した際、無関係になったはずの古いプリフィル文言が resurrect してしまう。
    if (
      pendingPrefillRef.current !== null &&
      pendingPrefillRef.current.projectId !== selectedProjectId
    ) {
      pendingPrefillRef.current = null;
    }
    let cancelled = false;
    const threadListRequestId = ++threadListRequestIdRef.current;
    const persisted = readPersistedChatThreads()[selectedProjectId];
    // bdboard-ysu(Opus レビュー SF1 で正確化): 「今このプロジェクトの選択が
    // ユーザーの明示操作による新規ドラフトかどうか」を、draftNonces と
    // selectedThreadIds の組み合わせで判定する。draftNonces[projectId] を
    // 実際に進める(≡ startNewDraftThread を呼ぶ)経路は2つある —
    // 「新規スレッド」ボタン(handleNewThread→startNewDraftThread)と、
    // エージェント切替(handleAgentChange、setDraftNonces を直接呼ぶ)。
    // どちらもユーザーの明示操作であり、どちらも同じタイミングで
    // selectedThreadIds[projectId] を undefined にする。
    //
    // 判定を「fetch 開始時点からの nonce の変化」ではなく「fetch 解決時点で
    // nonce>0 かつ選択が undefined のまま」という絶対条件にしているのは、
    // 後者(handleAgentChange 由来のケースや、コールドウィンドウ引き継ぎ
    // (chat/useColdKeyspaceAdoption.ts の adoptProjectFromColdKeyspace)
    // 由来のケース)ではドラフトへの切り替えが必ずしも「この fetch の in-flight
    // 中」に起きるとは限らない(コールドウィンドウ経由では、プロジェクト解決
    // effect が selectedProjectId を切り替えるのと同じタイミングで nonce も
    // 引き継がれて進むため、fetch 開始のスナップショットを取った時点で
    // 既に反映済みになり、「変化した」比較では検出できない)ため。nonce>0 は
    // 「このプロジェクトで一度でも明示的な新規ドラフト操作があった」ことを
    // 意味し、selectedThreadIds[projectId]===undefined は「その後、既存
    // スレッドへ明示的に切り替えていない(まだドラフトを見ている)」ことを
    // 意味する。両方満たす間は、fetch 解決による persisted/open[0] の自動
    // 選択で上書きしてはならない — でないと fetch 解決時に既存スレッド選択
    // へ無言で巻き戻ってしまう(bdboard-dpq 最終レビューの nit、bdboard-ysu
    // で修正)。ticket-context 経由の新規ドラフト(pendingTicketDraftProjectRef
    // 分岐)は自分自身の startNewDraftThread 呼び出しがこの判定より前に
    // return するため、影響しない。
    //
    // bdboard-ysu(Opus 再レビュー最終追補): この条件は「fetch の in-flight
    // 窓の間だけ」の一時的な保護ではない、持続的な条件である。ドラフトを
    // 作った後(fetch が一度解決済みで in-flight ではない状態)にプロジェクトを
    // 離れ、スレッドを選び直さないまま同じプロジェクトへ再訪した場合、その
    // 再訪で新たに発火する fetch の解決時にも(nonce>0 かつ選択が undefined の
    // ままである限り)同じ判定が働き、自動選択は依然としてスキップされる —
    // 「ユーザーが明示的に行った選択(ここではドラフトを見ている状態)を自動で
    // 覆さない」という dpq 系の不変条件を、fetch の特定の1回の in-flight
    // だけでなく「そのドラフトを見続けている間ずっと」適用した結果であり、
    // 意図した挙動(base との差分、実測確認済み)。ページをリロードすると
    // draftNonces は state なので消え(ドラフトは意図的に永続化しない、
    // startNewDraftThread 内の「N2: ドラフトへの切り替えは意図的に
    // writePersistedChatThreadState を呼ばない」コメント参照)、次回訪問時は
    // nonce が 0 に戻るため通常どおり persisted/open[0] の復元に戻る。
    const isExplicitDraftStillSelected = () =>
      (draftNoncesRef.current[selectedProjectId] ?? 0) > 0 &&
      selectedThreadIdsRef.current[selectedProjectId] === undefined;
    void fetchChatThreads(selectedProjectId)
      .then((threads) => {
        if (cancelled || threadListRequestId !== threadListRequestIdRef.current) return;
        setThreadLists((prev) => ({ ...prev, [selectedProjectId]: threads }));
        const available = new Set(threads.map((thread) => thread.sessionId));
        const persistedOpen = (persisted?.activeSessionIds ?? []).filter((id) =>
          available.has(id),
        );
        const open = persisted !== undefined
          ? persistedOpen
          : threads.map((thread) => thread.sessionId);
        setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: open }));
        if (pendingTicketDraftProjectRef.current === selectedProjectId) {
          pendingTicketDraftProjectRef.current = null;
          startNewDraftThread(selectedProjectId);
          return;
        }
        if (isExplicitDraftStillSelected()) {
          return;
        }
        const selected = persisted?.selectedSessionId && available.has(persisted.selectedSessionId)
          ? persisted.selectedSessionId : open[0];
        setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: selected }));
      })
      .catch(() => {
        if (cancelled || threadListRequestId !== threadListRequestIdRef.current) return;
        setThreadError('スレッド一覧の取得に失敗しました。');
        const open = persisted?.activeSessionIds ?? [];
        setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: [...open] }));
        if (pendingTicketDraftProjectRef.current === selectedProjectId) {
          pendingTicketDraftProjectRef.current = null;
          startNewDraftThread(selectedProjectId);
          return;
        }
        if (isExplicitDraftStillSelected()) {
          return;
        }
        setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: persisted?.selectedSessionId ?? open[0] }));
      });
    return () => { cancelled = true; };
  }, [
    selectedProjectId,
    setThreadError,
    // 第14d段: フックの引数になったので exhaustive-deps が求める分を加えた。
    // ref / useState の setter / 参照の変わらない startNewDraftThread だけ。
    pendingPrefillRef,
    pendingTicketDraftProjectRef,
    threadListRequestIdRef,
    draftNoncesRef,
    selectedThreadIdsRef,
    setThreadLists,
    setOpenThreadIds,
    setSelectedThreadIds,
    startNewDraftThread,
  ]);
}
