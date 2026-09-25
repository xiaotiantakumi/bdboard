import { useCallback } from 'react';
import {
  fetchChatThreads,
  type ChatThreadDto,
  type ChatSessionMessagesDto,
  type SessionTailMessageDto,
} from '../../api';
import { readPersistedChatThreads, writePersistedChatThreadState } from '../../chatThreadStorage';
import { toChatMessages, type ChatMessage } from './messages';
import { restoreThreadView } from './threadViewRestore';
import type { UseChatAgentModelStateResult } from './useChatAgentModelState';
import type { UseChatConversationsStateResult } from './useChatConversationsState';
import type { UseChatThreadListsResult } from './useChatThreadLists';
import type { UseConversationKeyResult } from './useConversationKey';

export interface UseChatSessionLifecycleParams
  extends Pick<UseConversationKeyResult, 'selectedThreadIdsRef' | 'setSelectedThreadIds' | 'draftNoncesRef'>,
    Pick<
      UseChatConversationsStateResult,
      'historyRequestIdRef' | 'setConversations' | 'setHistoryLoadedFor' | 'setLoadingHistoryFor' | 'setThreadModelIds'
    >,
    Pick<
      UseChatThreadListsResult,
      'openThreads' | 'openThreadIdsRef' | 'restoredProjectsRef' | 'setThreadLists' | 'setOpenThreadIds'
    >,
    Pick<UseChatAgentModelStateResult, 'setSelectedAgentId'> {
  selectedProjectId: string;
  cancelThreadConfirmDelete: () => void;
  /** chat/useDraftThreadLauncher.ts の 23u nonce 前進(第14b段)。 */
  advanceDraftNonceAfterSessionGone: (projectId: string) => void;
}

/**
 * bdboard-sso1.83 第15a段: ChatPanel.tsx に残っていた「セッションの出入りをスレッド
 * 一覧と会話ストアの両方へ書き込む」3つのハンドラを、組み立て層(controller)へ
 * 移す前の準備として move-only で抜き出したもの。
 * - applyRecoveredTurn: turn-status 回収(chat/useTurnStatusRecovery.ts、E8)が
 *   hydrate するときに呼ぶ。一覧がまだ復元されていないプロジェクトでは、先に
 *   chat/threadViewRestore.ts の規則で永続化から復元する(bdboard-tsen)。ドラフト表示中はこの選択切り替えを抑止する(bdboard-cemi)。
 * - handleHistorySessionGone: 履歴ローダー(chat/useChatHistoryLoader.ts、E12)が
 *   404/unknown session を見たときに呼ぶ(bdboard-23u の prune)。
 * - handleResumeDiscoveredSession: ドロワーの「CLIセッションを再開」から呼ぶ。
 * effect は持たない(useCallback 2つと、元どおり毎レンダー作り直す関数1つ)。
 * 本体・依存配列・読み取り方式(ref で読む/prev で読む/render の値で読む)は
 * 元のまま。handleHistorySessionGone の依存配列に selectedThreadIdsRef が無い
 * (exhaustive-deps の警告1件)のも元のまま持ってきた(ref は安定なので実害は無い)。
 */
export function useChatSessionLifecycle(params: UseChatSessionLifecycleParams) {
  const { selectedProjectId, selectedThreadIdsRef, setSelectedThreadIds } = params;
  const { historyRequestIdRef, setConversations, setHistoryLoadedFor, setLoadingHistoryFor, setThreadModelIds } = params;
  const { openThreadIdsRef, restoredProjectsRef, setThreadLists, setOpenThreadIds } = params;
  const { setSelectedAgentId, cancelThreadConfirmDelete, advanceDraftNonceAfterSessionGone, draftNoncesRef } = params;

  const applyRecoveredTurn = useCallback(
    (
      threads: ChatThreadDto[],
      payload: ChatSessionMessagesDto,
      detachedMatchesThisRecovery = false,
    ) => {
      // bdboard-tsen: スレッド一覧 effect(E7)がこのプロジェクトの open/選択をまだ復元して
      // いない(初回の一覧 fetch が in-flight)なら、E7 と同じ規則で永続化から復元した上に
      // 回収したセッションを足す。E7 の応答はこの後に届いても一覧・open・選択を当てない
      // (chat/useTurnStatusRecovery.ts が当てる直前に一覧の request-id を進める)ので、
      // ここで復元しないと開いていたスレッドと選択が失われ、永続化も回収分だけで上書きされた。
      //
      // bdboard-4w2d: 「まだ復元していない」の判定に openThreadIdsRef.current[projectId]
      // === undefined を代理として使っていたが、初回一覧の読込中に別経路
      // (chat/useChatSendCommits.ts の送信成功、handleAgentChange)が先に
      // openThreadIds[projectId] を作ると、この代理は「復元済み」と誤判定し、
      // 永続化からの復元(restoreThreadView)を飛ばして writePersistedChatThreadState で
      // open を racing write 分と回収分だけに上書きしていた。restoredProjectsRef
      // (chat/useChatThreadLists.ts)は「このプロジェクトの一覧・open を実際に
      // 復元する処理を通したか」だけを明示的に憶えるマーカーで、E7 が自分の復元後に
      // 立て、ここでも立てる。openThreadIds の中身の有無では推測しない。
      //
      // bdboard-4w2d(Opus レビュー blocker 1 対応): restoredProjectsRef への追加は
      // 同期的な ref 変更だが、openThreadIdsRef.current は
      // chat/useChatThreadLists.ts の `openThreadIdsRef.current = openThreadIds`
      // (関数本体のトップレベル、つまり次の再レンダー時)でしか追いつかない。E7 の
      // .then() がマークだけ済ませた直後、その再レンダーが走る前にこの hydrate が
      // 割り込むと、マークは立っているのに knownOpen はまだ古い(このプロジェクトが
      // 初めてなら undefined の)ままになり得る。knownOpen がまだ undefined のうちは
      // マーカーだけでは「復元済み」と判定しない(この一手だけの安全弁 — marker が
      // 立っていない限り knownOpen の有無だけで復元済み扱いにはならないので、
      // 「populated openThreadIds を復元済みの代理にする」という元のバグには戻らない)。
      const knownOpen = openThreadIdsRef.current[selectedProjectId];
      const alreadyRestored = restoredProjectsRef.current.has(selectedProjectId) && knownOpen !== undefined;
      const restored = alreadyRestored
        ? undefined
        : restoreThreadView(threads, readPersistedChatThreads()[selectedProjectId]);
      if (!alreadyRestored) {
        restoredProjectsRef.current.add(selectedProjectId);
      }
      // bdboard-4w2d: 復元を行う場合、永続化からの open と、この fetch の in-flight
      // 中に別経路が先に openThreadIds へ書いていた分の両方を残す(和集合)。
      // 復元を「永続化からの完全な置き換え」にすると、その racing write を
      // 握りつぶしてしまう。
      const currentOpen = alreadyRestored
        ? (knownOpen ?? [])
        : Array.from(new Set([...(restored?.open ?? []), ...(knownOpen ?? [])]));
      const nextOpen = [...currentOpen.filter((id) => id !== payload.sessionId), payload.sessionId];
      const currentSelected = selectedThreadIdsRef.current[selectedProjectId] ?? restored?.selected;
      // bdboard-cemi: チケット起動のドラフト表示中(draftNonces[projectId] > 0 かつ
      // selectedThreadIds[projectId] が未設定。判定式は
      // chat/useThreadListSync.ts の isExplicitDraftStillSelected と同じ)に turn-status
      // 回収が届いても、その明示的なドラフト選択を回収セッションで上書きしない。
      // E7(スレッド一覧)が先に届く順だとドラフト開始後にここへ来るため、この判定が
      // 無いと選択が無言で回収セッションへ切り替わりドラフトが隠れていた。
      // bdboard-cemi 追補(Opus レビュー major 指摘): ただし、この回収がこのタブ自身の
      // detached 送信(ドラフトから送信したが配信が切れ、selectedThreadIds がまだ
      // 確定していない)の結末そのものである場合は抑止しない — でないと送ったばかりの
      // 返信が回収されても選択が切り替わらず、返信が別タブに隠れたまま気づけなくなる
      // (この PR の修正が入る前は正しく切り替わっていた、既存挙動からの劣化だった)。
      // detachedMatchesThisRecovery は chat/turnStatusStep.ts の decideTurnStatusStep が
      // 既に計算している既存のシグナルをそのまま使う(chat/useTurnStatusRecovery.ts の
      // 呼び出し側から渡される)。
      const isExplicitDraftStillSelected =
        !detachedMatchesThisRecovery &&
        (draftNoncesRef.current[selectedProjectId] ?? 0) > 0 &&
        selectedThreadIdsRef.current[selectedProjectId] === undefined;
      const nextSelected = isExplicitDraftStillSelected ? undefined : currentSelected ?? payload.sessionId;
      setThreadLists((prev) => ({ ...prev, [selectedProjectId]: threads }));
      setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: nextOpen }));
      openThreadIdsRef.current = { ...openThreadIdsRef.current, [selectedProjectId]: nextOpen };
      setConversations((prev) => ({
        ...prev,
        [payload.sessionId]: {
          messages: toChatMessages(payload.messages),
          sessionId: payload.sessionId,
          agentId: payload.agentId,
        },
      }));
      setHistoryLoadedFor((prev) => ({ ...prev, [payload.sessionId]: true }));
      if (payload.model !== undefined && payload.model !== '') {
        setThreadModelIds((prev) => ({ ...prev, [payload.sessionId]: payload.model! }));
      }
      setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: nextSelected }));
      // bdboard-d7on: openThreadIdsRef と同じ理由(render-mirror の1レンダー遅延)で
      // selectedThreadIdsRef も同じ場所で直接同期する — でないと、この関数呼び出しの
      // 直後・再レンダーを挟まない同 tick で選択を読む別のハンドラ(E7 の復元、
      // commitSuccess 等)が古い選択を読んでしまう(bdboard-d7on Opus レビュー指摘)。
      selectedThreadIdsRef.current = { ...selectedThreadIdsRef.current, [selectedProjectId]: nextSelected };
      if (!isExplicitDraftStillSelected && nextSelected === payload.sessionId && payload.agentId !== '') {
        setSelectedAgentId(payload.agentId);
      }
      // bdboard-cemi 追補(Opus レビュー minor 指摘): 抑止時(isExplicitDraftStillSelected)は
      // selectedSessionId を undefined で上書きしない — chat/useDraftThreadLauncher.ts の
      // startNewDraftThread 内 N2 コメント(「ドラフトへの切り替えは永続化済みの選択を
      // そのまま残す」)と同じ不変条件をここでも守る。抑止していない通常経路は今まで
      // どおり nextSelected をそのまま書く。
      const persistedSelectedSessionId = isExplicitDraftStillSelected
        ? readPersistedChatThreads()[selectedProjectId]?.selectedSessionId
        : nextSelected;
      writePersistedChatThreadState(selectedProjectId, {
        activeSessionIds: nextOpen,
        selectedSessionId: persistedSelectedSessionId,
      });
    },
    [
      selectedProjectId,
      openThreadIdsRef,
      restoredProjectsRef,
      selectedThreadIdsRef,
      setThreadLists,
      setOpenThreadIds,
      setConversations,
      setHistoryLoadedFor,
      setThreadModelIds,
      setSelectedThreadIds,
      draftNoncesRef,
      setSelectedAgentId,
    ],
  );

  const handleHistorySessionGone = useCallback(
    (sessionId: string) => {
      const nextOpenAfterGone = (openThreadIdsRef.current[selectedProjectId] ?? []).filter(
        (id) => id !== sessionId,
      );
      setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: nextOpenAfterGone }));
      openThreadIdsRef.current = {
        ...openThreadIdsRef.current,
        [selectedProjectId]: nextOpenAfterGone,
      };
      // bdboard-23u: handleDeleteThread(threadOps.deleteThread、bdboard-sso1.83
      // 第10段で useChatThreadLists.ts へ移設済み)の prune と対称にする —
      // でないと閉じたスレッドの再オープン経路から死亡スレッドを再選択できる。
      setThreadLists((prev) => ({
        ...prev,
        [selectedProjectId]: (prev[selectedProjectId] ?? []).filter(
          (thread) => thread.sessionId !== sessionId,
        ),
      }));
      const wasSelected = selectedThreadIdsRef.current[selectedProjectId] === sessionId;
      if (wasSelected) {
        setSelectedThreadIds((prev) =>
          prev[selectedProjectId] === sessionId
            ? { ...prev, [selectedProjectId]: undefined }
            : prev,
        );
        // bdboard-d29q: 同じ理由(render-mirror の1レンダー遅延)で ref も直接同期する。
        selectedThreadIdsRef.current = { ...selectedThreadIdsRef.current, [selectedProjectId]: undefined };
        // bdboard-23u: handleCloseThread と同じパターンで選択クリアを
        // localStorage にも同期する。
        writePersistedChatThreadState(selectedProjectId, {
          activeSessionIds: nextOpenAfterGone,
          selectedSessionId: undefined,
        });
        // bdboard-23u: ドラフト nonce の前進(startNewDraftThread を意図的に使わない
        // 理由も含む)は chat/useDraftThreadLauncher.ts に置いた(第14b段)。
        advanceDraftNonceAfterSessionGone(selectedProjectId);
      }
    },
    [
      selectedProjectId,
      setOpenThreadIds,
      setThreadLists,
      setSelectedThreadIds,
      openThreadIdsRef,
      advanceDraftNonceAfterSessionGone,
    ],
  );

  /**
   * bdboard-3tw.104.3 レビュー MF2: adopt 直後は `selectedThreadIds[projectId]` を
   * 新しいセッションIDに向け、`openThreadIds`/`threadLists` を更新し、
   * `writePersistedChatThreadState` で永続化する(104.2 のマルチスレッド化前は
   * `conversations[selectedProjectId]` に直書きしていたが、会話キーはスレッド
   * (sessionId)単位になったのでプロジェクトIDキーでは合わなくなっていた)。
   *
   * M1(レビュー再指摘): 履歴シードは `/api/sessions/:id/tail`(ライブセッション
   * インデックス由来、実測10件程度)を別途叩くのではなく、adopt レスポンスに
   * 同梱された `seedMessages`(discovery が local-only ガード配下で既に読んだ
   * トランスクリプト末尾)をそのまま使う。終了済みセッション(この機能の主用途)は
   * ライブインデックスにまず載らないため、以前の実装(`fetchSessionTail` 呼び出し)
   * はほぼ確実に 404 していた。取れる会話が無ければ簡単な説明メッセージ1行に
   * フォールバックする。
   *
   * S4(レビュー指摘): `writePersistedChatThreadState`(localStorage への書き込み)は
   * `setOpenThreadIds` の updater 関数の中では呼ばない — React の StrictMode は
   * updater を2回呼び得るため、副作用がその中にあると二重発火する。ここでは
   * 既に render スコープにある `openThreads`(chat/useChatThreadLists.ts が
   * `openThreadIds[selectedProjectId] ?? []` から導出し、呼び出し側が毎レンダー渡す)から次の配列を計算し、
   * `setOpenThreadIds` には具体値を渡したうえで、副作用は updater の外側で呼ぶ
   * (`handleCloseThread` と同じパターン)。
   *
   * threadModelIds との関係(レビュー指摘: 意図された挙動): 下で
   * `historyLoadedFor[sessionId] = true` を先回りしてセットし、通常の
   * ChatMessageRepository 由来の履歴読み込み effect(`payload.model` から
   * `threadModelIds` を埋める側)を抑止している。そのため adopt したスレッドは
   * `threadModelIds` に何も入らず、モデルセレクトは選択中エージェントの既定モデルに
   * フォールバックする(= CLI セッション側が最後に使っていたモデルとは限らない)。
   * これはこの実装の既知の制約であり、修正対象ではない — 是正するには adopt
   * レスポンスにモデルIDも含めて `threadModelIds` を明示的に設定する追加変更が
   * 必要だが、現状スコープ外。
   *
   * S5(レビュー指摘・既知の制約): シードした会話は `conversations`(メモリ上の
   * state)にしか置かれず、`writePersistedChatThreadState` が永続化するのは
   * スレッドの開閉状態(`activeSessionIds`/`selectedSessionId`)だけでメッセージ
   * 本文は含まない。そのためページをリロードすると、スレッドタブ自体は
   * 復元されるがシードした会話内容は失われ、通常の履歴読み込み effect が
   * ChatMessageRepository(adopt 直後はまだ空)から読み直して「まだメッセージは
   * ありません」に戻る。M1 はサーバー側のデータソースの問題(ライブインデックス
   * vs トランスクリプト全体)を解決するもので、クライアント側の永続化範囲とは
   * 別の話であり、ここには畳み込めない。会話メッセージ全体をクライアント
   * ストレージへ永続化する設計変更は現状スコープ外のため、既知の制約として
   * 明文化するに留める。
   */
  const handleResumeDiscoveredSession = (
    sessionId: string,
    agentId: string,
    seedMessages: readonly SessionTailMessageDto[],
  ) => {
    const projectId = selectedProjectId;
    const fallbackNote: ChatMessage = {
      role: 'assistant',
      text: 'このCLIセッションの直近の会話をここに表示できませんでした。続きから会話できます。',
      at: Date.now(),
    };
    const seeded: ChatMessage[] =
      seedMessages.length > 0
        ? seedMessages.map((message, index) => ({
            role: message.role,
            text: message.text,
            at:
              message.timestamp !== undefined
                ? Date.parse(message.timestamp)
                : Date.now() + index,
          }))
        : [fallbackNote];

    // bdboard-2n8 レビュー should-fix: handleAgentChange と同じ理由でここでも
    // historyRequestIdRef を進める。resume したセッションIDが現在選択中の
    // 会話キーと同じ(=既にそのスレッドが開かれていて履歴フェッチが in-flight)
    // だった場合、キー自体は変わらないので通常の invalidation(currentConversationKey
    // の変化に伴う effect cleanup)が働かない。increment しないと、下でセットする
    // seeded conversation / agentId を、後から解決する古い履歴フェッチの `.then` が
    // (サーバー側の別内容で)上書きしてしまう。
    historyRequestIdRef.current += 1;
    setSelectedAgentId(agentId);
    setConversations((prev) => ({
      ...prev,
      [sessionId]: { messages: seeded, sessionId, agentId },
    }));
    // 履歴は上で seedMessages から取り込み済みなので、通常の(常に空の)
    // ChatMessageRepository 由来の自動読み込み effect は動かさない。
    setHistoryLoadedFor((prev) => ({ ...prev, [sessionId]: true }));

    const baseOpenThreads = [...(restoredProjectsRef.current.has(projectId)
      ? (openThreadIdsRef.current[projectId] ?? [])
      : (readPersistedChatThreads()[projectId]?.activeSessionIds ?? []))];
    const nextOpenThreads = baseOpenThreads.includes(sessionId)
      ? baseOpenThreads
      : [...baseOpenThreads, sessionId];
    setOpenThreadIds((prev) => ({ ...prev, [projectId]: nextOpenThreads }));
    openThreadIdsRef.current = { ...openThreadIdsRef.current, [projectId]: nextOpenThreads };
    restoredProjectsRef.current.add(projectId);
    writePersistedChatThreadState(projectId, {
      activeSessionIds: nextOpenThreads,
      selectedSessionId: sessionId,
    });

    setSelectedThreadIds((prev) => ({ ...prev, [projectId]: sessionId }));
    // bdboard-d7on: applyRecoveredTurn と同じ理由で selectedThreadIdsRef も同期する。
    selectedThreadIdsRef.current = { ...selectedThreadIdsRef.current, [projectId]: sessionId };
    cancelThreadConfirmDelete();
    setLoadingHistoryFor((prev) => (prev === sessionId ? null : prev));

    void fetchChatThreads(projectId)
      .then((threads) => {
        setThreadLists((prev) => ({ ...prev, [projectId]: threads }));
      })
      .catch(() => {
        // 一覧の更新に失敗してもタブ表示が「(無題)」になるだけで再開自体は成立している。
      });
  };

  return { applyRecoveredTurn, handleHistorySessionGone, handleResumeDiscoveredSession };
}
