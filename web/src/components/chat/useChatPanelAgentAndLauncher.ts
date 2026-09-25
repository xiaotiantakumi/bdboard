// bdboard-sso1.83 第15b段: ChatPanel.tsx のフック配線を controller
// (chat/useChatPanelController.ts)へ移したときの4区間のうち2つ目。
// 元の ChatPanel.tsx 306〜441 行目を行単位でそのまま(コメントごと)移した。
// 呼び出し順は useChatPanelStores → この区間 → useChatPanelSync で、元の並びと同じ。
// 前の区間の戻り値は controller が params に spread して渡す。
import { useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useHistoryBackClose } from '../../hooks/useHistoryBackClose';
import { useResizableSidePanel } from '../../hooks/useResizableSidePanel';
import { UI_STORAGE_KEYS } from '../../uiPersistedState';
import { usePlatformLimitation } from '../PlatformLimitationNotice';
import type { ChatPanelControllerParams } from './chatPanelTypes';
import { useChatAgentModelState } from './useChatAgentModelState';
import type { ChatPanelStores } from './useChatPanelStores';
import { useDraftPayloadRegistry } from './useDraftPayloadRegistry';
import { useDraftThreadLauncher } from './useDraftThreadLauncher';
import { useElapsedSeconds } from './useElapsedSeconds';

type UseChatPanelAgentAndLauncherParams = ChatPanelControllerParams &
  ChatPanelStores;

/**
 * 設計書 §1c の H1(usePlatformLimitation)・E1(useElapsedSeconds)・H2
 * (useChatAgentModelState)・パネル幅と最大化・ドラフト積載物の登録簿・ドラフトスレッドの
 * 起動(useDraftThreadLauncher)・H3(useHistoryBackClose)・H4/H5(useFocusTrap ×2)を、
 * 元の順で呼ぶ。
 */
export function useChatPanelAgentAndLauncher(params: UseChatPanelAgentAndLauncherParams) {
  const {
    selectedProjectId, currentConversationKey, setThreadModelIds, isSending, draftApplicators,
    draftNoncesRef, setDraftNonces, setSelectedThreadIds, historyRequestIdRef, setConversations,
    setHistoryLoadedFor, setLoadingHistoryFor, conversationInputsRef, conversationAttachmentsRef,
    draftSeedTextRef, setInput, updateConversationInputs, updateConversationAttachments,
    clearAttachmentError, setOpenThreadIds, restoredProjectsRef, cancelThreadConfirmDelete, onClose, panelRef,
    closeButtonRef, threadDrawerOpen, threadDrawerRef, threadDrawerCloseButtonRef,
    closeThreadDrawer,
  } = params;
  // 未対応プラットフォームでは入力自体を塞ぐ。案内を出したうえで送信でき、
  // 送って初めて 501 に気付く、では「無効化」になっていない
  // (bdboard-70z.9, PR#115 fable レビュー)。判定が付くまでは塞がない。
  const chatUnsupported = usePlatformLimitation('chat') !== null;
  // Chat Redesign 改善点3: 「考え中…」表示に経過秒数を出す。isSending が false→true
  // に変わるたびに 0 から数え直し、1秒ごとに更新する。Date.now() は開始時点で
  // 1回だけ読んで setInterval のクロージャに閉じ込め、以後は差分計算にのみ使う。
  const sendElapsedSeconds = useElapsedSeconds(isSending);
  // 会話(スレッド)ごとに直近確定したモデルIDをキャッシュする。サーバーから復元した
  // 値も、送信時に実際に使った値も、ここに会話キー(セッションID、または新規ドラフト
  // キー)で記録しておく。エージェント読み込みタイミング(M1)やスレッド切り替え
  // (MF3)に関わらず、「今表示している会話キーに対応する値があればそれを使う」
  // という1つの規則だけで両方のケースを解ける。
  //
  // bdboard-2n8: モデル select の onChange(手動選択、下の handleModelChange)でも
  // このキャッシュに書く。理由は2つ:
  // (a) 履歴フェッチが in-flight のときに手動選択すると、フェッチ解決時の
  //     setThreadModelIds が後勝ちで上書きしてしまう競合を防ぐ(履歴解決側は
  //     「まだ値が無いキーにだけ書く」よう変更済み)。
  // (b) 未送信ドラフトスレッド(draftKey)で選んだモデルも、そのキーのまま他の
  //     会話キーへ切り替えて戻ってきたとき(例: プロジェクトを切り替えて戻る)に
  //     保持されるようにする。104.9 ではドラフトキーをキャッシュに書く経路が
  //     単に無かっただけで、意図的な禁止ではなかった。
  //     注意(bdboard-2n8 レビュー訂正): draftKey は `new:${projectId}:${nonce}`
  //     で nonce はプロジェクト単位に保持されるため、「別プロジェクトへ切り替えて
  //     戻る」「開いているスレッドを全部閉じて選択スレッドが無くなる」「CLI
  //     セッション再開後にそのタブを閉じる」等の経路では同じ draftKey へ普通に
  //     戻ってくる(ChatPanel.test.tsx の対応するテストがこれを望ましい挙動として
  //     assert している)。つまり「古い draftKey のキャッシュエントリは二度と
  //     読まれない」という主張は誤り。クロスエージェントのモデル漏れを実際に
  //     防いでいるのはこの点ではなく、下の復元 effect が持つメンバーシップ
  //     チェック(`cached` が現在選択中エージェントの `models` に実在するときだけ
  //     適用し、無ければ既定モデルへフォールバックする)であり、エージェントを
  //     切り替える操作が draftKey の nonce を進めることでキーが自然に分離される
  //     ことも合わせて働く。
  const {
    agents,
    setAgents,
    selectedAgentId,
    setSelectedAgentId,
    selectedAgent,
    selectedAgentUnavailable,
    setSelectedModelId,
    chatModelSelections,
    showModelSelect,
    effectiveModelId,
    handleModelChange,
  } = useChatAgentModelState({
    selectedProjectId,
    currentConversationKey,
    setThreadModelIds,
  });
  const chatPanel = useResizableSidePanel(UI_STORAGE_KEYS.chatPanelWidth);
  const [isChatPanelMaximized, setIsChatPanelMaximized] = useState(false);
  // draftNoncesRef は chat/useConversationKey.ts(bdboard-sso1.83 第10段)へ移した。
  // bdboard-sso1.83 第2段: conversationInputsRef/conversationAttachmentsRef
  // (startNewDraftThread 等が stale closure を経由せず読むための「state を
  // ミラーする ref」、draftNoncesRef と同じパターン)・attachmentIdRef・
  // updateConversationAttachments は useChatDraftState.ts
  // (+ useChatAttachmentIngestion.ts)へ移した。以降は上の分割代入で受け取った
  // 各関数経由で読み書きする。
  // bdboard-c1pw / bdboard-ru4d: 会話キーで索かれる「ドラフト積載物」ストアの
  // 単一の登録簿(migrateDraftPayloadKey / purgeDraftPayloadKeys)。
  // bdboard-sso1.83 第14a段で chat/useDraftPayloadRegistry.ts へ move-only で
  // 抜き出した(対象ストアの列挙・意図的な非対象・依存配列の理由はそちら参照)。
  // 返す関数の参照安定性は adoptProjectFromColdKeyspace(chat/useColdKeyspaceAdoption.ts、
  // → E6)と E9 の依存配列の
  // 前提になっている。
  const { migrateDraftPayloadKey, purgeDraftPayloadKeys } = useDraftPayloadRegistry({
    draftApplicators,
    setThreadModelIds,
  });
  // selectedThreadIdsRef は chat/useConversationKey.ts、openThreadIdsRef は
  // chat/useChatThreadLists.ts、conversationsRef は
  // chat/useChatConversationsState.ts(いずれも bdboard-sso1.83
  // 第10段・第11段)へ移した。
  // appliedTicketContextTokenRef は chat/useTicketContextLaunch.ts(第14e段)へ移した。
  // requestAbortControllerRef は chat/useChatSendState.ts (第13a段) へ移した。

  // bdboard-sso1.83 第14b段: pendingPrefillRef / pendingTicketDraftProjectRef /
  // startNewDraftThread / handleNewThread(SF5)/ handleAgentChange と、23u の
  // 自動回復での nonce 前進(advanceDraftNonceAfterSessionGone)は
  // chat/useDraftThreadLauncher.ts へ抜き出した(不変条件 N1 と各引き継ぎの
  // 説明はそちら)。effect は持たないので、元の startNewDraftThread の位置で呼ぶ。
  const {
    pendingPrefillRef,
    pendingTicketDraftProjectRef,
    startNewDraftThread,
    handleNewThread,
    handleAgentChange,
    advanceDraftNonceAfterSessionGone,
  } = useDraftThreadLauncher({
    selectedProjectId,
    currentConversationKey,
    draftNoncesRef,
    setDraftNonces,
    setSelectedThreadIds,
    historyRequestIdRef,
    setConversations,
    setHistoryLoadedFor,
    setLoadingHistoryFor,
    setThreadModelIds,
    conversationInputsRef,
    conversationAttachmentsRef,
    draftSeedTextRef,
    setInput,
    updateConversationInputs,
    updateConversationAttachments,
    clearAttachmentError,
    setOpenThreadIds,
    restoredProjectsRef,
    setSelectedAgentId,
    cancelThreadConfirmDelete,
  });

  const { requestClose } = useHistoryBackClose({
    panelId: 'chat',
    onClose,
  });

  // bdboard-f1c9: ドロワー開閉と相互排他(TunnelControl/TicketDetailPanel と同型)。
  // useFocusTrap の Tab 処理は defaultPrevented を見ないため、ネストした2トラップを
  // 同時 enabled にすると境界判定が競合しうる。
  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: requestClose,
    enabled: !threadDrawerOpen,
  });

  useFocusTrap({
    containerRef: threadDrawerRef,
    initialFocusRef: threadDrawerCloseButtonRef,
    enabled: threadDrawerOpen,
    onEscape: closeThreadDrawer,
  });


  return {
    chatUnsupported, sendElapsedSeconds, agents, setAgents, selectedAgentId, setSelectedAgentId,
    selectedAgent, selectedAgentUnavailable, setSelectedModelId, chatModelSelections,
    showModelSelect, effectiveModelId, handleModelChange, chatPanel, isChatPanelMaximized,
    setIsChatPanelMaximized, migrateDraftPayloadKey, purgeDraftPayloadKeys, pendingPrefillRef,
    pendingTicketDraftProjectRef, startNewDraftThread, handleNewThread, handleAgentChange,
    advanceDraftNonceAfterSessionGone, requestClose,
  };
}

export type ChatPanelAgentAndLauncher = ReturnType<typeof useChatPanelAgentAndLauncher>;
