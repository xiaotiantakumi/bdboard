import { useCallback, type MutableRefObject } from 'react';
import {
  fetchChatThreads,
  type ChatThreadDto,
  type ChatSessionMessagesDto,
  type SessionTailMessageDto,
} from '../../api';
import { readPersistedChatThreads, writePersistedChatThreadState } from '../../chatThreadStorage';
import { dropGoneFromPersistedOpen } from './dropGoneFromPersistedOpen';
import { toAdoptionSeedMessages, toChatMessages } from './messages';
import { pruneDeadOpenThreads } from './pruneDeadOpenThreads';
import { planRecoveredTurn } from './recoveredTurnPlan';
import { takeUnobservedOrigin, withHistoryLoaded, withoutKey, type ReplacedThreadMarks } from './replacedThread';
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
      'openThreads' | 'openThreadIdsRef' | 'restoredProjectsRef' | 'provisionalEntries' | 'setThreadLists' | 'setOpenThreadIds' | 'threadListOrder'
    >,
    Pick<UseChatAgentModelStateResult, 'setSelectedAgentId'> {
  selectedProjectId: string;
  /** bdboard-w9hv: 回収が返すセッションの送信元(置き換えられたスレッド)を辿る印。 */
  replacedMarksRef: MutableRefObject<ReplacedThreadMarks>;
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
 * 元のまま。ただし applyRecoveredTurn の open・選択の決定(置き換えられたスレッドを外す
 * 判断を含む)は chat/recoveredTurnPlan.ts の planRecoveredTurn へ移した(bdboard-w9hv。
 * 復元・ドラフト抑止の規則は変えていない)。handleHistorySessionGone の依存配列に
 * selectedThreadIdsRef が無い(exhaustive-deps の警告1件)のは元のまま持ってきた
 * (ref は安定なので実害は無い)。
 */
export function useChatSessionLifecycle(params: UseChatSessionLifecycleParams) {
  const { selectedProjectId, selectedThreadIdsRef, setSelectedThreadIds } = params;
  const { historyRequestIdRef, setConversations, setHistoryLoadedFor, setLoadingHistoryFor, setThreadModelIds } = params;
  const { openThreadIdsRef, restoredProjectsRef, provisionalEntries, setThreadLists, setOpenThreadIds, threadListOrder } = params;
  const { setSelectedAgentId, cancelThreadConfirmDelete, advanceDraftNonceAfterSessionGone, draftNoncesRef } = params;
  const { replacedMarksRef } = params;

  const applyRecoveredTurn = useCallback(
    (
      threads: ChatThreadDto[],
      payload: ChatSessionMessagesDto,
      detachedMatchesThisRecovery = false,
      // bdboard-z9mn: この一覧 fetch の開始順序番号(chat/threadListFetchOrder.ts。回収が一覧の fetch を
      // 始める直前に取る)。省略したときは「いま始めた fetch の一覧」として扱う。
      listFetchSeq: number = threadListOrder.begin(selectedProjectId),
    ) => {
      // bdboard-z9mn: この一覧より後に始まった fetch(採用の取り直しなど)の一覧が既に当たっていれば
      // orderedThreads は undefined — 回収の一覧は古いので書かない(採用したタブのタイトルを戻さない)。
      // open・選択・会話は、一覧の新旧に関わらず回収したセッションを当てる。
      const orderedThreads = threadListOrder.admit(selectedProjectId, listFetchSeq, threads);
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
      // bdboard-4w2d(Opus レビュー blocker 1 対応、bdboard-33jm 追記): 発見時点
      // (openThreadIdsRef が chat/useChatThreadLists.ts の
      // `openThreadIdsRef.current = openThreadIds` という render 中の代入
      // だけで、次の再レンダーまで追いつかなかった)には、restoredProjectsRef
      // への追加(同期的な ref 変更)と openThreadIdsRef の追いつきにズレがあり、
      // E7 の .then() がマークだけ済ませた直後にこの hydrate が割り込むと
      // knownOpen が古いままになり得た。openThreadIdsRef は bdboard-33jm 以降
      // useLiveMirroredState 経由で常に最新なのでこのズレ自体は無くなったが、
      // knownOpen が undefined のうちはマーカーだけでは「復元済み」と判定しない
      // 安全弁は変更コストが無いのでそのまま残している。
      const knownOpen = openThreadIdsRef.current[selectedProjectId];
      // bdboard-521p: 初回の一覧 fetch が失敗した E7 は restoredProjectsRef を立てるが、サーバー一覧とは合わせていない
      // (knownOpen は永続化のフォールバック = エントリが無ければ [])。それを「復元済み」と読むと、ここが回収したセッション 1 つだけを
      // 利用者の記録として保存して settle し、次の訪問ではそれしか開かれない。一覧が取れなかった印のあるプロジェクトは未復元として扱う。
      const alreadyRestored = restoredProjectsRef.current.has(selectedProjectId) && knownOpen !== undefined &&
        !provisionalEntries.isListUnavailable(selectedProjectId);
      restoredProjectsRef.current.add(selectedProjectId);
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
      // bdboard-w9hv: 回収したセッションが、見届けられなかった sessionId 無しの再送(clearSession 後)の
      // 結果なら、置き換えられた送信元のスレッドを open・選択・永続化から外す(commitSuccess と同じ
      // 規則。chat/recoveredTurnPlan.ts → chat/replacedThread.ts)。スレッド一覧は下でサーバーの
      // 一覧に置き換わるので、gone の判定は要らない。
      // 引き取りは ref の書き換え(記録を消す)なので、引数のオブジェクトの中に隠さず先に読む。
      const origin = takeUnobservedOrigin(replacedMarksRef.current, selectedProjectId);
      const persisted = readPersistedChatThreads()[selectedProjectId];
      // bdboard-rt6i: 永続化済みのエントリが、初回訪問の E7 の一覧 fetch が in-flight の間に書かれた仮のエントリなら、
      // 再訪の記録として扱わない(planRecoveredTurn が閉じた id を除くサーバー一覧を全部開く)。広げる元の一覧は
      // E7 の listForFirstVisit と同じ: この一覧が古い(orderedThreads が undefined)なら、当たっている一覧を使う。
      const provisionalEntry = provisionalEntries.isProvisional(selectedProjectId, persisted);
      const plannedThreads = orderedThreads ?? (provisionalEntry ? threadListOrder.appliedList(selectedProjectId) : undefined) ?? threads;
      const { nextOpen, nextSelected, persistedSelected, replacedKey } = planRecoveredTurn({
        threads: plannedThreads, sessionId: payload.sessionId, alreadyRestored, knownOpen, explicitDraftSelected: isExplicitDraftStillSelected,
        origin,
        persisted, provisionalEntry, closedIds: provisionalEntries.closedIds(selectedProjectId),
        knownSelected: selectedThreadIdsRef.current[selectedProjectId],
      });
      // bdboard-rt6i: 回収の hydrate も復元の 1 つ。一覧と合わせて書き直す(下の永続化)ので、仮のエントリは下ろす。
      provisionalEntries.settle(selectedProjectId);
      if (orderedThreads !== undefined) {
        setThreadLists((prev) => ({ ...prev, [selectedProjectId]: orderedThreads }));
      }
      setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: nextOpen }));
      setConversations((prev) => ({
        ...withoutKey(prev, replacedKey),
        [payload.sessionId]: {
          messages: toChatMessages(payload.messages),
          sessionId: payload.sessionId,
          agentId: payload.agentId,
        },
      }));
      setHistoryLoadedFor((prev) => withHistoryLoaded(prev, payload.sessionId, replacedKey));
      if (payload.model !== undefined && payload.model !== '') {
        setThreadModelIds((prev) => ({ ...prev, [payload.sessionId]: payload.model! }));
      }
      setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: nextSelected }));
      // bdboard-d7on/bdboard-33jm: openThreadIdsRef と同じ理由(async 継続からの
      // stale closure 対策)で selectedThreadIdsRef も最新でなければならない —
      // でないと、この関数呼び出しの直後・再レンダーを挟まない同 tick で選択を
      // 読む別のハンドラ(E7 の復元、commitSuccess 等)が古い選択を読んでしまう
      // (bdboard-d7on Opus レビュー指摘)。上の setSelectedThreadIds が
      // useLiveMirroredState の set なので、この時点で selectedThreadIdsRef.current
      // は既に同期済み(手で代入する必要は無い)。
      if (!isExplicitDraftStillSelected && nextSelected === payload.sessionId && payload.agentId !== '') {
        setSelectedAgentId(payload.agentId);
      }
      // bdboard-cemi 追補(Opus レビュー minor 指摘): 抑止時(isExplicitDraftStillSelected)は
      // selectedSessionId を undefined で上書きしない — chat/useDraftThreadLauncher.ts の
      // startNewDraftThread 内 N2 コメント(「ドラフトへの切り替えは永続化済みの選択を
      // そのまま残す」)と同じ不変条件をここでも守る(persistedSelected、
      // chat/recoveredTurnPlan.ts)。抑止していない通常経路は今までどおり nextSelected を書く。
      writePersistedChatThreadState(selectedProjectId, {
        activeSessionIds: nextOpen,
        selectedSessionId: persistedSelected,
      });
    },
    [
      selectedProjectId,
      openThreadIdsRef,
      restoredProjectsRef,
      provisionalEntries,
      selectedThreadIdsRef,
      setThreadLists,
      setOpenThreadIds,
      setConversations,
      setHistoryLoadedFor,
      setThreadModelIds,
      setSelectedThreadIds,
      draftNoncesRef,
      setSelectedAgentId,
      replacedMarksRef,
      threadListOrder,
    ],
  );

  const handleHistorySessionGone = useCallback(
    (sessionId: string) => {
      const nextOpenAfterGone = (openThreadIdsRef.current[selectedProjectId] ?? []).filter((id) => id !== sessionId);
      setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: nextOpenAfterGone }));
      // bdboard-z9mn: 死んだセッションのローカル書き込みの記録を捨てる(古い一覧で蘇らせない)。
      threadListOrder.forgetEntry(selectedProjectId, sessionId);
      // bdboard-23u: handleDeleteThread(threadOps.deleteThread、bdboard-sso1.83
      // 第10段で useChatThreadLists.ts へ移設済み)の prune と対称にする —
      // でないと閉じたスレッドの再オープン経路から死亡スレッドを再選択できる。
      setThreadLists((prev) => ({
        ...prev,
        [selectedProjectId]: (prev[selectedProjectId] ?? []).filter(
          (thread) => thread.sessionId !== sessionId,
        ),
      }));
      // bdboard-v9tz: 選択中だった場合は下の if 内で選択クリアと一緒に永続化を書く。選択中ではない id が
      // 消えたときは else で、メモリの open と同じく永続化の activeSessionIds からも落とす
      // (chat/dropGoneFromPersistedOpen.ts)。どちらも書き込みは setState の updater の外。
      // 基点が if はメモリの open、else は永続化なのは意図どおり: else は一覧が未復元(メモリの open が空)
      // でも他の id を巻き込まないため。選択中の if 側に来るときは実質いつも復元済み。
      const wasSelected = selectedThreadIdsRef.current[selectedProjectId] === sessionId;
      if (wasSelected) {
        setSelectedThreadIds((prev) =>
          prev[selectedProjectId] === sessionId
            ? { ...prev, [selectedProjectId]: undefined }
            : prev,
        );
        // bdboard-23u: handleCloseThread と同じパターンで選択クリアを
        // localStorage にも同期する。未復元で最初のエントリを書くなら仮のエントリ(bdboard-rt6i)。
        provisionalEntries.markIfFirstEntry(selectedProjectId);
        writePersistedChatThreadState(selectedProjectId, {
          activeSessionIds: nextOpenAfterGone,
          selectedSessionId: undefined,
        });
        // bdboard-23u: ドラフト nonce の前進(startNewDraftThread を意図的に使わない
        // 理由も含む)は chat/useDraftThreadLauncher.ts に置いた(第14b段)。
        advanceDraftNonceAfterSessionGone(selectedProjectId);
      } else dropGoneFromPersistedOpen(selectedProjectId, sessionId, selectedThreadIdsRef.current[selectedProjectId]);
    },
    [
      selectedProjectId,
      setOpenThreadIds,
      setThreadLists,
      setSelectedThreadIds,
      openThreadIdsRef,
      advanceDraftNonceAfterSessionGone,
      threadListOrder,
      provisionalEntries,
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
   * 復元済みのプロジェクトなら `openThreadIdsRef.current[projectId]`(bdboard-d7on 以降。
   * render スコープの `openThreads` ではなく、useLiveMirroredState で常に最新の ref)、
   * 未復元なら永続化済みの activeSessionIds から次の配列を計算し、
   * `setOpenThreadIds` には具体値を渡したうえで、副作用は updater の外側で呼ぶ
   * (`handleCloseThread` と同じパターン)。
   *
   * bdboard-oaak: 未復元の基点はサーバー一覧で絞れていない永続化 id なので、採用の後の
   * 一覧 fetch が届いたとき、その基点のうち一覧に無い id を open と永続化から落とす
   * (chat/pruneDeadOpenThreads.ts。復元の経路 restoreThreadView と同じ規則)。
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
    // bdboard-z9mn: 取り込み用の変換は chat/messages.ts へ移した(このファイルの max-lines のため。挙動は同じ)。
    const seeded = toAdoptionSeedMessages(seedMessages);

    // bdboard-2n8 レビュー should-fix: handleAgentChange と同じ理由でここでも
    // historyRequestIdRef を進める。resume したセッションIDが現在選択中の
    // 会話キーと同じ(=既にそのスレッドが開かれていて履歴フェッチが in-flight)
    // だった場合、キー自体は変わらないので通常の invalidation(currentConversationKey
    // の変化に伴う effect cleanup)が働かない。increment しないと、下でセットする
    // seeded conversation / agentId を、後から解決する古い履歴フェッチの `.then` が
    // (サーバー側の別内容で)上書きしてしまう。
    historyRequestIdRef.current += 1;
    setSelectedAgentId(agentId);
    setConversations((prev) => ({ ...prev, [sessionId]: { messages: seeded, sessionId, agentId } }));
    // 履歴は上で seedMessages から取り込み済みなので、通常の(常に空の)
    // ChatMessageRepository 由来の自動読み込み effect は動かさない。
    setHistoryLoadedFor((prev) => ({ ...prev, [sessionId]: true }));

    // bdboard-oaak: 未復元(初回の一覧 fetch が in-flight)のときだけ、基点が「サーバー一覧で
    // まだ絞っていない永続化 id」になる。下の fetch が届いたら、その基点のうち一覧に無い id を落とす。
    const usedPersistedBase = !restoredProjectsRef.current.has(projectId);
    // bdboard-rt6i: 未復元で最初の永続化エントリを書く採用は仮のエントリ(chat/provisionalEntry.ts)。印の判定は
    // restoredProjectsRef を読むので、下の restoredProjectsRef.current.add より前に呼ぶ。
    provisionalEntries.markIfFirstEntry(projectId);
    provisionalEntries.noteReopened(projectId, sessionId);
    const baseOpenThreads = [...(usedPersistedBase
      ? (readPersistedChatThreads()[projectId]?.activeSessionIds ?? [])
      : (openThreadIdsRef.current[projectId] ?? []))];
    const nextOpenThreads = baseOpenThreads.includes(sessionId)
      ? baseOpenThreads
      : [...baseOpenThreads, sessionId];
    setOpenThreadIds((prev) => ({ ...prev, [projectId]: nextOpenThreads }));
    restoredProjectsRef.current.add(projectId);
    writePersistedChatThreadState(projectId, {
      activeSessionIds: nextOpenThreads,
      selectedSessionId: sessionId,
    });

    setSelectedThreadIds((prev) => ({ ...prev, [projectId]: sessionId }));
    cancelThreadConfirmDelete();
    setLoadingHistoryFor((prev) => (prev === sessionId ? null : prev));

    // bdboard-z9mn: 取り直しの開始順序番号。E7・回収の一覧より後に始まったなら、先に始まった(古い)
    // それらの一覧が後から届いても、この一覧を上書きしない。逆に、あとから始まった取り直し・回収の一覧が
    // 先に当たっていれば、この一覧は古いので書かない(採用が 2 回続いたときの 1 回目の取り直しなど)。
    // threadListRequestIdRef は進めない — 進めると回収の hydrate が止まる(chat/useTurnStatusRecovery.ts)。
    const listFetchSeq = threadListOrder.begin(projectId);
    void fetchChatThreads(projectId)
      .then((threads) => {
        const orderedThreads = threadListOrder.admit(projectId, listFetchSeq, threads);
        if (orderedThreads !== undefined) {
          setThreadLists((prev) => ({ ...prev, [projectId]: orderedThreads }));
        }
        // 古い一覧でも、基点の永続化 id のうち一覧に無いものが落ちたこと自体は新しい一覧にも当てはまるので、
        // 下の prune は応答の新旧に関わらず行う(基点の id はこの採用より前から存在していた)。
        if (!usedPersistedBase) return;
        // bdboard-oaak: 採用は restoredProjectsRef を立てるので、この後に届く E7 の応答は open を
        // 復元し直さない。サーバーがもう持たない永続化 id を残すと「(無題)」タブになるため落とす。
        pruneDeadOpenThreads({
          projectId,
          adoptedSessionId: sessionId,
          baseOpenThreads,
          threads,
          openThreadIdsRef,
          setOpenThreadIds,
          selectedThreadIdsRef,
          setSelectedThreadIds,
        });
      })
      .catch(() => {
        // 一覧の更新に失敗してもタブ表示が「(無題)」になるだけで再開自体は成立している。
      });
  };

  return { applyRecoveredTurn, handleHistorySessionGone, handleResumeDiscoveredSession };
}
