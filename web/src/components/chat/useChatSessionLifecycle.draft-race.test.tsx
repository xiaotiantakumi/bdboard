// bdboard-d29q: useDraftThreadLauncher(書き手: startNewDraftThread が
// draftNonces/selectedThreadIds を進める)と useChatSessionLifecycle(読み手:
// applyRecoveredTurn の isExplicitDraftStillSelected)が、本物の
// useConversationKey が持つ同じ draftNoncesRef/selectedThreadIdsRef
// (chat/useConversationKey.ts、フック本体のトップレベルで `ref.current = state`
// する render-mirror)を共有する統合 probe。
//
// なぜ useChatSessionLifecycle.test.tsx の applyRecoveredTurn 単体テストでは
// 再現できないか: あのテストは draftNoncesRef/selectedThreadIdsRef を手で
// 「古いまま」の値に固定して渡す。これは「もし古い値が渡されたら何が起きるか」の
// 記述にはなるが、書き手側(useDraftThreadLauncher)がどう直そうと(ref を
// 同期的に更新しようと)、手で固定した値は絶対に更新されないので、そのテストは
// 直しようがない(=直った後も無限に赤いまま)。本当の回帰テストにするには、
// 書き手と読み手を同じ ref を共有する形で実際に両方呼び出し、「書き手が呼ばれた
// 直後、再レンダーを1度も挟まずに読み手が呼ばれる」という本番のタイミングを
// 強制的に再現する必要がある。
//
// 再現方法(force ordering、タイマー/sleep 不使用): E7(chat/useThreadListSync.ts)
// の consumePendingTicketDraft は startNewDraftThread を呼ぶだけの関数で、
// startNewDraftThread は setDraftNonces/setSelectedThreadIds を積むだけ
// (react の setState)。React はこれらの状態更新を act() コールバックが終わるまで
// 反映(再レンダー)しない。したがって同じ act() コールバックの中で
// startNewDraftThread を呼んだ直後に applyRecoveredTurn を呼べば、
// draftNoncesRef.current/selectedThreadIdsRef.current が「まだ前回レンダーの
// 値のまま」という本番の窓を、1回の同期呼び出しで確実に(sleep や再試行なしで)
// 再現できる。
import { act, renderHook } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatSessionMessagesDto, ChatThreadDto } from '../../api';
import type { ChatAttachment } from './attachments';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, fetchChatThreads: vi.fn(() => Promise.resolve<ChatThreadDto[]>([])) };
});

import { useChatConversationsState } from './useChatConversationsState';
import { useChatSessionLifecycle } from './useChatSessionLifecycle';
import { useConversationKey } from './useConversationKey';
import { useDraftThreadLauncher } from './useDraftThreadLauncher';

function thread(sessionId: string, title: string): ChatThreadDto {
  return { sessionId, agentId: 'agent-a', title, pinned: false, updatedAt: '2026-01-01T00:00:00.000Z' };
}

const RECOVERED: ChatSessionMessagesDto = {
  sessionId: 'sess-rec',
  agentId: 'agent-b',
  model: 'model-2',
  messages: [{ role: 'assistant', content: 'recovered', createdAt: '2026-08-18T12:00:00.000Z' }],
};

function useProbe(projectId: string) {
  const key = useConversationKey(projectId);
  const conv = useChatConversationsState();
  const openThreadIdsRef = useRef<Record<string, string[]>>({});
  const restoredProjectsRef = useRef<Set<string>>(new Set());
  // pendingPrefillRef.current が null のままの経路(このテストのシナリオ)では
  // startNewDraftThread はこれらを一切呼ばないので、素の vi.fn/plain ref で十分
  // (chat/useChatDraftState.ts の本物を組み立てる必要が無い)。
  const [setOpenThreadIds] = useState(() => vi.fn());
  const [setThreadLists] = useState(() => vi.fn());
  const [setSelectedAgentId] = useState(() => vi.fn());
  const [cancelThreadConfirmDelete] = useState(() => vi.fn());
  const conversationInputsRef = useRef<Record<string, string>>({});
  const conversationAttachmentsRef = useRef<Record<string, ChatAttachment[]>>({});
  const draftSeedTextRef = useRef<Record<string, string>>({});
  const [setInput] = useState(() => vi.fn());
  const [updateConversationInputs] = useState(() => vi.fn());
  const [updateConversationAttachments] = useState(() => vi.fn());
  const [clearAttachmentError] = useState(() => vi.fn());

  const launcher = useDraftThreadLauncher({
    selectedProjectId: projectId,
    currentConversationKey: key.currentConversationKey,
    draftNoncesRef: key.draftNoncesRef,
    selectedThreadIdsRef: key.selectedThreadIdsRef,
    setDraftNonces: key.setDraftNonces,
    setSelectedThreadIds: key.setSelectedThreadIds,
    historyRequestIdRef: conv.historyRequestIdRef,
    setConversations: conv.setConversations,
    setHistoryLoadedFor: conv.setHistoryLoadedFor,
    setLoadingHistoryFor: conv.setLoadingHistoryFor,
    setThreadModelIds: conv.setThreadModelIds,
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

  const lifecycle = useChatSessionLifecycle({
    selectedProjectId: projectId,
    selectedThreadIdsRef: key.selectedThreadIdsRef,
    setSelectedThreadIds: key.setSelectedThreadIds,
    draftNoncesRef: key.draftNoncesRef,
    historyRequestIdRef: conv.historyRequestIdRef,
    setConversations: conv.setConversations,
    setHistoryLoadedFor: conv.setHistoryLoadedFor,
    setLoadingHistoryFor: conv.setLoadingHistoryFor,
    setThreadModelIds: conv.setThreadModelIds,
    openThreads: [],
    openThreadIdsRef,
    restoredProjectsRef,
    setThreadLists,
    setOpenThreadIds,
    setSelectedAgentId,
    cancelThreadConfirmDelete,
    advanceDraftNonceAfterSessionGone: launcher.advanceDraftNonceAfterSessionGone,
  });

  return { key, launcher, lifecycle, restoredProjectsRef, openThreadIdsRef };
}

describe('useDraftThreadLauncher + useChatSessionLifecycle: cross-hook draft/recovery race (bdboard-d29q)', () => {
  it('keeps a just-started ticket-launch draft selected when turn-status recovery lands in the same tick as startNewDraftThread, before the next render (force-ordering repro, no sleep)', () => {
    const { result } = renderHook(() => useProbe('project-a'));

    act(() => {
      // E7(chat/useThreadListSync.ts)の .then() が実際に行う順序をそのまま
      // 再現する: (1) 一覧を復元済みとしてマーク(plain ref なので同期的に反映)、
      // (2) 保留中のチケット起動ドラフトを startNewDraftThread で開始
      // (consumePendingTicketDraft の中身そのもの)。
      result.current.restoredProjectsRef.current.add('project-a');
      result.current.launcher.startNewDraftThread('project-a');
      // (3) その直後、再レンダーを1度も挟まないまま turn-status 回収の hydrate が
      // 届く(chat/useTurnStatusRecovery.ts 経由の applyRecoveredTurn)。まだ
      // サーバー一覧に載っていなかった段階の一覧に回収セッションが増えて返る想定。
      result.current.lifecycle.applyRecoveredTurn(
        [
          thread('sess-1', 'first thread'),
          thread('sess-2', 'second thread'),
          thread('sess-rec', 'recovered thread'),
        ],
        RECOVERED,
      );
    });

    // 表示中のチケット起動ドラフトの選択(undefined)が、無言で回収セッションや
    // restoreThreadView の既定選択(先頭スレッド 'sess-1')へ上書きされていないこと。
    //
    // 修正前(bdboard-d29q 未修正)の実際の壊れ方: draftNoncesRef/
    // selectedThreadIdsRef が render-mirror のまま(次の再レンダーまで
    // startNewDraftThread の更新に追いつかない)ので、applyRecoveredTurn の
    // isExplicitDraftStillSelected が「ドラフトはまだ無い」と誤判定し、選択は
    // 永続化が無い新規プロジェクトの既定則(restoreThreadView: 永続化が無ければ
    // 先頭スレッドを選ぶ)に従って 'sess-1' に倒れる。
    expect(result.current.key.selectedThreadIds['project-a']).toBeUndefined();
    expect(result.current.key.draftNonces['project-a']).toBe(1);
  });

  it('keeps a just-started ticket-launch draft selected even when the project was already restored with a different thread selected (P1: revisit, not a fresh/unpersisted project)', () => {
    // bdboard-d29q Opus レビュー(finding 1): 最初のテストはプロジェクトが未復元
    // (persisted state 無し)の場合しか踏まない。より典型的な「以前から開いている
    // プロジェクトで、別スレッドが選択された状態からチケット起動する」経路
    // (alreadyRestored=true, currentSelected が restored?.selected ではなく
    // selectedThreadIdsRef.current の既存値そのものになる経路)は未検証だった。
    // このテストはその経路を踏む。
    const { result } = renderHook(() => useProbe('project-a'));

    act(() => {
      // このプロジェクトはすでに E7 で復元済み(restoredProjectsRef に登録済みかつ
      // openThreadIdsRef.current が populated)で、'sess-old' が選択されている
      // ―― という「直前のレンダーまでに確定していた状態」を、ref を直接書いて
      // 再現する(ref 自体への代入は再レンダーを起こさないので、この act() の中では
      // 何も反映されず、次の act() まで static に残る。本物の env では、この状態は
      // 実際の以前のレンダーが作る)。
      result.current.restoredProjectsRef.current.add('project-a');
      result.current.openThreadIdsRef.current = { 'project-a': ['sess-old'] };
      result.current.key.selectedThreadIdsRef.current = { 'project-a': 'sess-old' };
    });

    act(() => {
      // チケット起動でドラフトを開始した直後、再レンダーを挟まずに turn-status
      // 回収が届く(1つ目のテストと同じ force ordering)。
      result.current.launcher.startNewDraftThread('project-a');
      result.current.lifecycle.applyRecoveredTurn(
        [thread('sess-old', 'old thread'), thread('sess-rec', 'recovered thread')],
        RECOVERED,
      );
    });

    // 修正前の壊れ方(このケース固有): alreadyRestored なので restoreThreadView は
    // 呼ばれず、currentSelected は selectedThreadIdsRef.current(まだ startNewDraftThread
    // の更新に追いついていない古い 'sess-old')をそのまま読む。isExplicitDraftStillSelected
    // も selectedThreadIdsRef.current !== undefined で誤って false になるため、
    // 選択は 'sess-1' のような一覧先頭ではなく、直前に見ていた 'sess-old' へ
    // 無言で戻ってしまう(1つ目のテストとは異なる壊れ方だが、原因は同じ)。
    expect(result.current.key.selectedThreadIds['project-a']).toBeUndefined();
    expect(result.current.key.draftNonces['project-a']).toBe(1);
  });
});
