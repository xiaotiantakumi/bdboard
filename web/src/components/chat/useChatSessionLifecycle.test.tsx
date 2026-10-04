import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionMessagesDto, ChatThreadDto } from '../../api';
import { readPersistedChatThreads, writePersistedChatThreadState } from '../../chatThreadStorage';
import { createProvisionalEntryMarks } from './provisionalEntry';
import { createReplacedThreadMarks } from './replacedThread';
import { createThreadListFetchOrder } from './threadListFetchOrder';
import { useChatSessionLifecycle, type UseChatSessionLifecycleParams } from './useChatSessionLifecycle';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, fetchChatThreads: vi.fn(() => Promise.resolve<ChatThreadDto[]>([])) };
});

import { fetchChatThreads } from '../../api';

const fetchChatThreadsMock = vi.mocked(fetchChatThreads);

function thread(sessionId: string, title: string | null = null): ChatThreadDto {
  return { sessionId, agentId: 'agent-a', title, pinned: false, updatedAt: '2026-01-01T00:00:00.000Z' };
}

/** vi.fn に渡された最後の引数を、関数型更新なら prev に適用し、値ならそのまま返す。 */
function lastUpdate<T>(setter: ReturnType<typeof vi.fn>, prev: T): T {
  const arg = setter.mock.calls.at(-1)![0] as T | ((value: T) => T);
  return typeof arg === 'function' ? (arg as (value: T) => T)(prev) : arg;
}

function setup(overrides: Partial<UseChatSessionLifecycleParams> = {}) {
  // bdboard-33jm: 本番の useLiveMirroredState は setState と ref.current の更新を
  // 同じ set 関数の中で同期させる(呼び出し元での手書き同期を廃止した)。この probe も
  // 同じ契約を再現し、setOpenThreadIds/setSelectedThreadIds を呼ぶたびに対応する
  // ref.current を書き換える(lastUpdate() でも mock.calls をそのまま読める)。
  const openThreadIdsRef = overrides.openThreadIdsRef ?? { current: {} };
  const selectedThreadIdsRef = overrides.selectedThreadIdsRef ?? { current: {} };
  const setOpenThreadIds = vi.fn((next: unknown) => {
    openThreadIdsRef.current =
      typeof next === 'function'
        ? (next as (prev: typeof openThreadIdsRef.current) => typeof openThreadIdsRef.current)(
            openThreadIdsRef.current,
          )
        : (next as typeof openThreadIdsRef.current);
  });
  const setSelectedThreadIds = vi.fn((next: unknown) => {
    selectedThreadIdsRef.current =
      typeof next === 'function'
        ? (next as (
            prev: typeof selectedThreadIdsRef.current,
          ) => typeof selectedThreadIdsRef.current)(selectedThreadIdsRef.current)
        : (next as typeof selectedThreadIdsRef.current);
  });
  // bdboard-rt6i: 仮のエントリの印は、(上書きされた場合も含め)このテストの restoredProjectsRef を読む。
  const restoredProjectsRef = overrides.restoredProjectsRef ?? { current: new Set<string>() };
  const params: UseChatSessionLifecycleParams = {
    selectedProjectId: 'project-a',
    selectedThreadIdsRef,
    draftNoncesRef: { current: {} },
    setSelectedThreadIds,
    historyRequestIdRef: { current: 0 },
    setConversations: vi.fn(),
    setHistoryLoadedFor: vi.fn(),
    setLoadingHistoryFor: vi.fn(),
    setThreadModelIds: vi.fn(),
    openThreads: [],
    openThreadIdsRef,
    restoredProjectsRef,
    provisionalEntries: createProvisionalEntryMarks((id) => restoredProjectsRef.current.has(id)),
    threadListOrder: createThreadListFetchOrder(),
    setThreadLists: vi.fn(),
    setOpenThreadIds,
    setSelectedAgentId: vi.fn(),
    cancelThreadConfirmDelete: vi.fn(),
    advanceDraftNonceAfterSessionGone: vi.fn(),
    replacedMarksRef: { current: createReplacedThreadMarks() },
    ...overrides,
  };
  const hook = renderHook((props: UseChatSessionLifecycleParams) => useChatSessionLifecycle(props), {
    initialProps: params,
  });
  return { ...hook, params };
}

const RECOVERED: ChatSessionMessagesDto = {
  sessionId: 'sess-rec',
  agentId: 'agent-b',
  model: 'model-2',
  messages: [{ role: 'assistant', content: 'recovered', createdAt: '2026-08-18T12:00:00.000Z' }],
};

describe('useChatSessionLifecycle', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchChatThreadsMock.mockReset();
    fetchChatThreadsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('applyRecoveredTurn', () => {
    it('opens, selects and hydrates the recovered session when nothing is selected', () => {
      const threads = [thread('sess-rec', 'recovered title')];
      const { result, params } = setup({
        openThreadIdsRef: { current: { 'project-a': ['sess-old'] } },
        // bdboard-4w2d: この項目はすでに一覧が復元済み(E7 が先に走った)という
        // 前提を openThreadIdsRef の値で表していたので、restoredProjectsRef も
        // 同じ前提に合わせて明示的に立てる(openThreadIds の有無で「復元済み」を
        // 推測しなくなったため)。
        restoredProjectsRef: { current: new Set(['project-a']) },
      });
      act(() => result.current.applyRecoveredTurn(threads, RECOVERED));

      expect(lastUpdate(params.setThreadLists as ReturnType<typeof vi.fn>, {})).toEqual({ 'project-a': threads });
      expect(
        lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, { 'project-a': ['stale'], other: ['x'] }),
      ).toEqual({ 'project-a': ['sess-old', 'sess-rec'], other: ['x'] });
      expect(lastUpdate(params.setConversations as ReturnType<typeof vi.fn>, {})).toEqual({
        'sess-rec': {
          sessionId: 'sess-rec',
          agentId: 'agent-b',
          messages: [{ role: 'assistant', text: 'recovered', at: Date.parse('2026-08-18T12:00:00.000Z') }],
        },
      });
      expect(lastUpdate(params.setHistoryLoadedFor as ReturnType<typeof vi.fn>, {})).toEqual({ 'sess-rec': true });
      expect(lastUpdate(params.setThreadModelIds as ReturnType<typeof vi.fn>, { keep: 'm' })).toEqual({
        keep: 'm',
        'sess-rec': 'model-2',
      });
      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': 'sess-rec',
      });
      expect(params.setSelectedAgentId).toHaveBeenCalledWith('agent-b');
      expect(readPersistedChatThreads()).toEqual({
        'project-a': { activeSessionIds: ['sess-old', 'sess-rec'], selectedSessionId: 'sess-rec' },
      });
    });

    it('keeps an existing selection, moves an already-open id to the end, and leaves the agent alone', () => {
      const { result, params } = setup({
        selectedThreadIdsRef: { current: { 'project-a': 'sess-1' } },
        openThreadIdsRef: { current: { 'project-a': ['sess-rec', 'sess-1'] } },
        restoredProjectsRef: { current: new Set(['project-a']) },
      });
      act(() => result.current.applyRecoveredTurn([], RECOVERED));

      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': ['sess-1', 'sess-rec'],
      });
      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': 'sess-1',
      });
      expect(params.setSelectedAgentId).not.toHaveBeenCalled();
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-1', 'sess-rec'],
        selectedSessionId: 'sess-1',
      });
    });

    it('keeps an explicit draft selected instead of switching to the recovered session (bdboard-cemi)', () => {
      const { result, params } = setup({
        draftNoncesRef: { current: { 'project-a': 1 } },
        openThreadIdsRef: { current: { 'project-a': ['sess-old'] } },
        restoredProjectsRef: { current: new Set(['project-a']) },
      });
      act(() => result.current.applyRecoveredTurn([thread('sess-old')], RECOVERED));

      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': undefined,
      });
      expect(params.setSelectedAgentId).not.toHaveBeenCalled();
      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': ['sess-old', 'sess-rec'],
      });
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-old', 'sess-rec'],
        selectedSessionId: undefined,
      });
    });

    it('still switches to the recovered session when this tab is waiting on its own detached send, even while an explicit draft looks selected (bdboard-cemi Opus-review fix)', () => {
      const { result, params } = setup({
        draftNoncesRef: { current: { 'project-a': 1 } },
        openThreadIdsRef: { current: { 'project-a': ['sess-old'] } },
        restoredProjectsRef: { current: new Set(['project-a']) },
      });
      act(() => result.current.applyRecoveredTurn([thread('sess-old')], RECOVERED, true));

      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': 'sess-rec',
      });
      expect(params.setSelectedAgentId).toHaveBeenCalledWith('agent-b');
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-old', 'sess-rec'],
        selectedSessionId: 'sess-rec',
      });
    });

    it('preserves a previously persisted selection instead of wiping it to undefined when suppressing (bdboard-cemi Opus-review fix)', () => {
      writePersistedChatThreadState('project-a', {
        activeSessionIds: ['sess-real'],
        selectedSessionId: 'sess-real',
      });
      const { result, params } = setup({
        draftNoncesRef: { current: { 'project-a': 1 } },
        openThreadIdsRef: { current: { 'project-a': ['sess-old'] } },
        restoredProjectsRef: { current: new Set(['project-a']) },
      });
      act(() => result.current.applyRecoveredTurn([thread('sess-old')], RECOVERED));

      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': undefined,
      });
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-old', 'sess-rec'],
        selectedSessionId: 'sess-real',
      });
    });

    it('keeps a real (non-draft) thread selected instead of switching to the recovered session, even with a stale draft nonce (bdboard-cemi)', () => {
      const { result, params } = setup({
        draftNoncesRef: { current: { 'project-a': 3 } },
        selectedThreadIdsRef: { current: { 'project-a': 'sess-1' } },
      });
      act(() => result.current.applyRecoveredTurn([], RECOVERED));

      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': 'sess-1',
      });
      expect(params.setSelectedAgentId).not.toHaveBeenCalled();
    });

    it('restores the persisted open threads and selection first when the project list is not restored yet (bdboard-tsen)', () => {
      writePersistedChatThreadState('project-a', {
        activeSessionIds: ['sess-gone', 'sess-1', 'sess-2'],
        selectedSessionId: 'sess-2',
      });
      const threads = [thread('sess-1'), thread('sess-2'), thread('sess-rec')];
      const { result, params } = setup();
      act(() => result.current.applyRecoveredTurn(threads, RECOVERED));

      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': ['sess-1', 'sess-2', 'sess-rec'],
      });
      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': 'sess-2',
      });
      expect(params.setSelectedAgentId).not.toHaveBeenCalled();
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-1', 'sess-2', 'sess-rec'],
        selectedSessionId: 'sess-2',
      });
    });

    it('opens every listed thread and selects the first when nothing is persisted and the list is not restored yet (bdboard-tsen)', () => {
      const threads = [thread('sess-1'), thread('sess-rec')];
      const { result, params } = setup();
      act(() => result.current.applyRecoveredTurn(threads, RECOVERED));

      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': ['sess-1', 'sess-rec'],
      });
      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': 'sess-1',
      });
    });

    it('ignores the persisted state once the project list is restored (an empty open list counts)', () => {
      writePersistedChatThreadState('project-a', { activeSessionIds: ['sess-1'], selectedSessionId: 'sess-1' });
      // bdboard-4w2d: 「復元済み」は openThreadIds が空配列であること自体では
      // 判定しない(空配列は「未復元で currentOpen が空」とも区別が付かない)。
      // ここでは restoredProjectsRef を明示的に立てて「復元済み・0件」を表す。
      const { result, params } = setup({
        openThreadIdsRef: { current: { 'project-a': [] } },
        restoredProjectsRef: { current: new Set(['project-a']) },
      });
      act(() => result.current.applyRecoveredTurn([thread('sess-1'), thread('sess-rec')], RECOVERED));

      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({ 'project-a': ['sess-rec'] });
      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': 'sess-rec',
      });
    });

    it('merges the persisted open threads with a racing openThreadIds write instead of mistaking it for "already restored" (bdboard-4w2d)', () => {
      // bdboard-4w2d の再現: 初回一覧の読込中に別経路(useChatSendCommits.ts の
      // 送信成功や handleAgentChange)が先に openThreadIds[projectId] を作ると、
      // 以前は openThreadIdsRef.current[projectId] === undefined という代理判定が
      // 「もう復元済み」と誤認し、restoreThreadView を呼ばずに racing write の
      // 中身(sess-new だけ)をそのまま使っていた。結果、永続化にあった
      // sess-old が nextOpen から失われていた。restoredProjectsRef はまだ
      // 立っていない(このプロジェクトを実際に復元する処理はまだ誰も通っていない)。
      writePersistedChatThreadState('project-a', {
        activeSessionIds: ['sess-old', 'sess-new'],
        selectedSessionId: 'sess-new',
      });
      const threads = [thread('sess-old'), thread('sess-new')];
      const { result, params } = setup({
        openThreadIdsRef: { current: { 'project-a': ['sess-new'] } },
      });
      act(() => result.current.applyRecoveredTurn(threads, RECOVERED));

      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': ['sess-old', 'sess-new', 'sess-rec'],
      });
      // 実際に復元する処理を通した後は、次回以降のためにマーカーを立てる。
      expect(params.restoredProjectsRef.current.has('project-a')).toBe(true);
    });

    it('preserves a racing openThreadIds write even when persisted storage does not (yet) know about it (bdboard-4w2d, Opus レビュー major 指摘対応)', () => {
      // 上のテストは racing write(sess-new)が persisted にも既に載っていたため、
      // 和集合を取らずに persisted 側だけを使っても偶然同じ結果になり、和集合の
      // 必要性そのものは検証できていなかった(Opus レビューが mutation-check で
      // 指摘: 和集合を丸ごと削っても全テストが通った)。ここでは racing write が
      // 足したセッション(sess-brand-new)を persisted の activeSessionIds に
      // 含めないことで、和集合を取らなければ確実に失われる形にする。
      writePersistedChatThreadState('project-a', {
        activeSessionIds: ['sess-old'],
        selectedSessionId: 'sess-old',
      });
      const threads = [thread('sess-old'), thread('sess-rec')];
      const { result, params } = setup({
        openThreadIdsRef: { current: { 'project-a': ['sess-brand-new'] } },
      });
      act(() => result.current.applyRecoveredTurn(threads, RECOVERED));

      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': ['sess-old', 'sess-brand-new', 'sess-rec'],
      });
      expect(params.restoredProjectsRef.current.has('project-a')).toBe(true);
    });

    it('still restores from persisted storage when the marker is set but openThreadIdsRef has not caught up yet (bdboard-4w2d, Opus レビュー blocker 1 対応)', () => {
      // restoredProjectsRef への追加は同期的な ref 変更だが、openThreadIdsRef.current は
      // chat/useChatThreadLists.ts の `openThreadIdsRef.current = openThreadIds` という
      // 関数本体トップレベルの代入でしか追いつかない(= 次の再レンダーまで古いまま)。
      // E7 の .then() がマークだけ先に済ませ、その再レンダーより前にこの hydrate が
      // 割り込むと、マーカーは立っているのに knownOpen はまだ undefined(このプロジェクト
      // 初回)ということが起き得る。ここでマーカーだけを信じて「復元済み・knownOpen は
      // undefined ⇒ currentOpen = []」としてしまうと、persisted にあった sess-old が
      // 消えてしまう。
      writePersistedChatThreadState('project-a', {
        activeSessionIds: ['sess-old'],
        selectedSessionId: 'sess-old',
      });
      const threads = [thread('sess-old'), thread('sess-rec')];
      const { result, params } = setup({
        restoredProjectsRef: { current: new Set(['project-a']) },
        // openThreadIdsRef はデフォルトの { current: {} } のまま(project-a はまだ undefined)。
      });
      act(() => result.current.applyRecoveredTurn(threads, RECOVERED));

      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': ['sess-old', 'sess-rec'],
      });
      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': 'sess-old',
      });
    });

    it('does not write a model for a missing or empty model, nor an agent for an empty agentId', () => {
      const { result, params } = setup();
      act(() => result.current.applyRecoveredTurn([], { ...RECOVERED, model: undefined, agentId: '' }));
      act(() => result.current.applyRecoveredTurn([], { ...RECOVERED, model: '' }));
      expect(params.setThreadModelIds).not.toHaveBeenCalled();
      expect(params.setSelectedAgentId).toHaveBeenCalledTimes(1);
    });

    it('keeps the callback identity across renders until the project changes', () => {
      const { result, rerender, params } = setup();
      const first = result.current.applyRecoveredTurn;
      rerender({ ...params, openThreads: ['sess-x'] });
      expect(result.current.applyRecoveredTurn).toBe(first);
      rerender({ ...params, selectedProjectId: 'project-b' });
      expect(result.current.applyRecoveredTurn).not.toBe(first);
    });
  });

  // bdboard-w9hv: 再送が abort / 配信停止で見届けられず、返答が回収で戻ったとき、送信元の
  // 置き換えられたスレッド(origin)を commitSuccess と同じ規則で外す。origin は
  // deliverChatSend が replacedMarksRef.unobservedOrigins[projectId] に憶えている。
  describe('applyRecoveredTurn — thread-list fetch order (bdboard-z9mn)', () => {
    it('writes the recovered list when no later-started list was applied, laying a rename made after the fetch started over it', () => {
      const threadListOrder = createThreadListFetchOrder();
      const { result, params } = setup({
        openThreadIdsRef: { current: { 'project-a': ['sess-old'] } },
        restoredProjectsRef: { current: new Set(['project-a']) },
        threadListOrder,
      });
      const seq = threadListOrder.begin('project-a');
      threadListOrder.noteEntryWrite('project-a', thread('sess-old', 'renamed'), 'replace');
      act(() => result.current.applyRecoveredTurn([thread('sess-old', 'old title'), thread('sess-rec')], RECOVERED, false, seq));

      expect(lastUpdate(params.setThreadLists as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': [thread('sess-old', 'renamed'), thread('sess-rec')],
      });
    });

    it('does not write a recovered list that started before an already-applied list, but still applies the recovered session', () => {
      const threadListOrder = createThreadListFetchOrder();
      const { result, params } = setup({
        openThreadIdsRef: { current: { 'project-a': ['sess-old', 'sess-adopted'] } },
        restoredProjectsRef: { current: new Set(['project-a']) },
        threadListOrder,
      });
      const recoverySeq = threadListOrder.begin('project-a');
      // 採用の取り直し(回収より後に始まった)の一覧が先に当たっている。
      const adoptionSeq = threadListOrder.begin('project-a');
      expect(threadListOrder.admit('project-a', adoptionSeq, [thread('sess-adopted', 'resumed')])).toBeDefined();
      act(() => result.current.applyRecoveredTurn([thread('sess-rec')], RECOVERED, false, recoverySeq));

      expect(params.setThreadLists).not.toHaveBeenCalled();
      // 回収したセッションは、一覧の新旧に関わらず open と会話に当たる。
      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': ['sess-old', 'sess-adopted', 'sess-rec'],
      });
      expect(params.setConversations).toHaveBeenCalled();
    });

    it('treats a call without a start number as a list that starts now', () => {
      const threadListOrder = createThreadListFetchOrder();
      const { result, params } = setup({
        openThreadIdsRef: { current: { 'project-a': ['sess-old'] } },
        restoredProjectsRef: { current: new Set(['project-a']) },
        threadListOrder,
      });
      const earlier = threadListOrder.begin('project-a');
      expect(threadListOrder.admit('project-a', earlier, [thread('sess-old')])).toBeDefined();
      act(() => result.current.applyRecoveredTurn([thread('sess-rec')], RECOVERED));

      expect(lastUpdate(params.setThreadLists as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': [thread('sess-rec')],
      });
    });
  });

  describe('applyRecoveredTurn — the thread replaced by a re-send (bdboard-w9hv)', () => {
    function setupReplaced(overrides: Partial<UseChatSessionLifecycleParams> = {}, origin: string | null = 'sess-dead') {
      const marks = createReplacedThreadMarks();
      if (origin !== null) marks.unobservedOrigins['project-a'] = origin;
      marks.goneKeys.add('sess-dead');
      return setup({
        replacedMarksRef: { current: marks },
        openThreadIdsRef: { current: { 'project-a': ['sess-other', 'sess-dead'] } },
        selectedThreadIdsRef: { current: { 'project-a': 'sess-other' } },
        restoredProjectsRef: { current: new Set(['project-a']) },
        ...overrides,
      });
    }

    it('drops the replaced thread from open, the persisted entry, the conversation store and the history-loaded flag, and consumes the record', () => {
      const { result, params } = setupReplaced();
      act(() => result.current.applyRecoveredTurn([thread('sess-other'), thread('sess-rec')], RECOVERED));

      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': ['sess-other', 'sess-rec'],
      });
      const conversations = lastUpdate(params.setConversations as ReturnType<typeof vi.fn>, {
        'sess-dead': { messages: [] },
        'sess-other': { messages: [] },
      });
      expect(Object.keys(conversations).sort()).toEqual(['sess-other', 'sess-rec']);
      expect(
        lastUpdate(params.setHistoryLoadedFor as ReturnType<typeof vi.fn>, { 'sess-dead': true, 'sess-other': true }),
      ).toEqual({ 'sess-other': true, 'sess-rec': true });
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-other', 'sess-rec'],
        selectedSessionId: 'sess-other',
      });
      expect(params.replacedMarksRef.current.unobservedOrigins).toEqual({});
      expect(params.replacedMarksRef.current.goneKeys.has('sess-dead')).toBe(false);
    });

    it('moves the selection to the recovered session when the replaced thread was the selected one', () => {
      const { result, params } = setupReplaced({ selectedThreadIdsRef: { current: { 'project-a': 'sess-dead' } } });
      act(() => result.current.applyRecoveredTurn([thread('sess-other'), thread('sess-rec')], RECOVERED));

      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': 'sess-rec',
      });
      expect(params.setSelectedAgentId).toHaveBeenCalledWith('agent-b');
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-other', 'sess-rec'],
        selectedSessionId: 'sess-rec',
      });
    });

    it('keeps an explicit draft selected but moves a persisted selection that pointed at the replaced thread (bdboard-cemi, bdboard-e5cz)', () => {
      writePersistedChatThreadState('project-a', {
        activeSessionIds: ['sess-other', 'sess-dead'],
        selectedSessionId: 'sess-dead',
      });
      const { result, params } = setupReplaced({
        draftNoncesRef: { current: { 'project-a': 1 } },
        selectedThreadIdsRef: { current: {} },
      });
      act(() => result.current.applyRecoveredTurn([thread('sess-other'), thread('sess-rec')], RECOVERED));

      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': undefined,
      });
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-other', 'sess-rec'],
        selectedSessionId: 'sess-rec',
      });
    });

    it('also drops the replaced thread when the list is not restored yet and the server still lists it (chat agent mismatch)', () => {
      writePersistedChatThreadState('project-a', {
        activeSessionIds: ['sess-dead', 'sess-other'],
        selectedSessionId: 'sess-other',
      });
      const { result, params } = setupReplaced({
        openThreadIdsRef: { current: {} },
        selectedThreadIdsRef: { current: {} },
        restoredProjectsRef: { current: new Set() },
      });
      act(() =>
        result.current.applyRecoveredTurn([thread('sess-dead'), thread('sess-other'), thread('sess-rec')], RECOVERED),
      );

      // 一覧には残るので閉じたスレッドとして再オープンできる。open と永続化からは外れる。
      expect(
        lastUpdate<Record<string, ChatThreadDto[]>>(params.setThreadLists as ReturnType<typeof vi.fn>, {})['project-a'],
      ).toHaveLength(3);
      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': ['sess-other', 'sess-rec'],
      });
      expect(readPersistedChatThreads()['project-a']?.activeSessionIds).toEqual(['sess-other', 'sess-rec']);
    });

    it('does not treat a draft key, an unknown key, or no record at all as a replaced thread', () => {
      for (const origin of ['draft:project-a:1', 'sess-not-open', null]) {
        localStorage.clear();
        const { result, params } = setupReplaced({}, origin);
        act(() => result.current.applyRecoveredTurn([thread('sess-other'), thread('sess-rec')], RECOVERED));
        expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
          'project-a': ['sess-other', 'sess-dead', 'sess-rec'],
        });
        expect(lastUpdate(params.setHistoryLoadedFor as ReturnType<typeof vi.fn>, { 'sess-dead': true })).toEqual({
          'sess-dead': true,
          'sess-rec': true,
        });
      }
    });

    it('ignores a leftover record when the recovered session is already open (it is not a newly started session)', () => {
      const { result, params } = setupReplaced({
        openThreadIdsRef: { current: { 'project-a': ['sess-dead', 'sess-rec'] } },
      });
      act(() => result.current.applyRecoveredTurn([thread('sess-dead'), thread('sess-rec')], RECOVERED));

      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': ['sess-dead', 'sess-rec'],
      });
      expect(params.replacedMarksRef.current.unobservedOrigins).toEqual({});
    });

    it('applies the record to one recovery only', () => {
      const { result, params } = setupReplaced();
      act(() => result.current.applyRecoveredTurn([thread('sess-other'), thread('sess-rec')], RECOVERED));
      act(() =>
        result.current.applyRecoveredTurn([thread('sess-other'), thread('sess-rec'), thread('sess-next')], {
          ...RECOVERED,
          sessionId: 'sess-next',
        }),
      );

      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': ['sess-other', 'sess-rec', 'sess-next'],
      });
    });
  });

  describe('the provisional first entry (bdboard-rt6i)', () => {
    const SERVER = [thread('sess-a', 'a'), thread('sess-b', 'b'), thread('sess-new', 'sent'), thread('sess-rec', 'recovered')];

    /** 送信成功・採用と同じ順: 未復元でエントリが無いうちに印を立ててから、最初のエントリ [sess-new] を書く。 */
    function provisionalFirstEntry() {
      const restoredProjectsRef = { current: new Set<string>() };
      const provisionalEntries = createProvisionalEntryMarks((id) => restoredProjectsRef.current.has(id));
      provisionalEntries.markIfFirstEntry('project-a');
      writePersistedChatThreadState('project-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
      return { restoredProjectsRef, provisionalEntries };
    }

    it('widens a provisional [N] with the server list on a recovery, instead of treating it as a revisit (gap 1)', () => {
      // 未復元(restoredProjectsRef 未マーク)で、送信成功が最初のエントリ [sess-new] を書き、印を立てた。
      const { restoredProjectsRef, provisionalEntries } = provisionalFirstEntry();
      const { result, params } = setup({
        restoredProjectsRef,
        provisionalEntries,
        openThreadIdsRef: { current: { 'project-a': ['sess-new'] } },
        selectedThreadIdsRef: { current: { 'project-a': 'sess-new' } },
      });
      act(() => result.current.applyRecoveredTurn(SERVER, RECOVERED));

      expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-a', 'sess-b', 'sess-new', 'sess-rec'] });
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-new', 'sess-rec'],
        selectedSessionId: 'sess-new',
      });
      // 回収の復元でマーカーは下りる(永続化は一覧と合わせた記録になった)。
      expect(provisionalEntries.isProvisional('project-a', readPersistedChatThreads()['project-a'])).toBe(false);
      // bdboard-521p: 保存エントリの印も下りている(下りていなければ次の訪問でまた広げる)。
      expect(readPersistedChatThreads()['project-a']).not.toHaveProperty('provisional');
      expect(readPersistedChatThreads()['project-a']).not.toHaveProperty('provisionalClosedSessionIds');
      expect(params.restoredProjectsRef.current.has('project-a')).toBe(true);
    });

    it('still reads a persisted entry as the source of truth on a recovery when no provisional mark is set', () => {
      // 再訪(開始時にエントリがある)や、閉じる・削除で書いた利用者の記録: マーカーは無い。
      writePersistedChatThreadState('project-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
      const { result, params } = setup({
        openThreadIdsRef: { current: { 'project-a': ['sess-new'] } },
        selectedThreadIdsRef: { current: { 'project-a': 'sess-new' } },
      });
      act(() => result.current.applyRecoveredTurn(SERVER, RECOVERED));

      expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-new', 'sess-rec'] });
      expect(readPersistedChatThreads()['project-a']?.activeSessionIds).toEqual(['sess-new', 'sess-rec']);
    });

    it('widens an adopted open with the server list on a recovery too: the recovery supersedes the E7 response that would have', () => {
      // 採用は restoredProjectsRef を立てるので alreadyRestored。それでも採用が書いた最初のエントリは仮のエントリ。
      const { restoredProjectsRef, provisionalEntries } = provisionalFirstEntry();
      restoredProjectsRef.current.add('project-a');
      const { result, params } = setup({
        provisionalEntries,
        restoredProjectsRef,
        openThreadIdsRef: { current: { 'project-a': ['sess-new'] } },
        selectedThreadIdsRef: { current: { 'project-a': 'sess-new' } },
      });
      act(() => result.current.applyRecoveredTurn(SERVER, RECOVERED));

      expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-a', 'sess-b', 'sess-new', 'sess-rec'] });
      expect(provisionalEntries.isProvisional('project-a', readPersistedChatThreads()['project-a'])).toBe(false);
    });

    it('leaves a thread the user closed during the provisional entry out of the widened open set', () => {
      const { restoredProjectsRef, provisionalEntries } = provisionalFirstEntry();
      provisionalEntries.noteClosed('project-a', 'sess-b');
      const { result, params } = setup({
        restoredProjectsRef,
        provisionalEntries,
        openThreadIdsRef: { current: { 'project-a': ['sess-new'] } },
        selectedThreadIdsRef: { current: { 'project-a': 'sess-new' } },
      });
      act(() => result.current.applyRecoveredTurn(SERVER, RECOVERED));

      expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-a', 'sess-new', 'sess-rec'] });
      // 一覧と合わせて復元したので、閉じた id の記録も下りる。
      expect(provisionalEntries.closedIds('project-a').size).toBe(0);
    });

    it('widens from the list that is already applied when the recovery list itself is stale (same list as the E7 widen)', () => {
      const { restoredProjectsRef, provisionalEntries } = provisionalFirstEntry();
      const threadListOrder = createThreadListFetchOrder();
      const staleSeq = threadListOrder.begin('project-a');
      const newerSeq = threadListOrder.begin('project-a');
      // より新しい fetch(採用の取り直しなど)の一覧が先に当たり、サーバーには sess-c も増えている。
      threadListOrder.admit('project-a', newerSeq, [...SERVER, thread('sess-c', 'c')]);
      const { result, params } = setup({
        restoredProjectsRef,
        provisionalEntries,
        threadListOrder,
        openThreadIdsRef: { current: { 'project-a': ['sess-new'] } },
        selectedThreadIdsRef: { current: { 'project-a': 'sess-new' } },
      });
      // 回収の一覧は古い(sess-c を知らない)。広げる元は応答ではなく、当たっている一覧。
      act(() => result.current.applyRecoveredTurn(SERVER, RECOVERED, false, staleSeq));

      expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-a', 'sess-b', 'sess-new', 'sess-c', 'sess-rec'] });
    });

    it('does not treat an agent change\'s empty entry as provisional on a recovery: handleAgentChange settles the mark', () => {
      // 実際の順を再生する: 未復元でエントリが無いうちに送信が印を立て([sess-x] を書く)、そのあと handleAgentChange が
      // [] を書き、同じハンドラで settle して復元済みにする。settle を外すと印のある [] は仮のエントリになり、回収が広げる。
      const restoredProjectsRef = { current: new Set<string>() };
      const provisionalEntries = createProvisionalEntryMarks((id) => restoredProjectsRef.current.has(id));
      provisionalEntries.markIfFirstEntry('project-a');
      writePersistedChatThreadState('project-a', { activeSessionIds: ['sess-x'], selectedSessionId: 'sess-x' });
      writePersistedChatThreadState('project-a', { activeSessionIds: [] });
      provisionalEntries.settle('project-a');
      restoredProjectsRef.current.add('project-a');
      const { result, params } = setup({
        provisionalEntries,
        restoredProjectsRef,
        openThreadIdsRef: { current: { 'project-a': [] } },
        selectedThreadIdsRef: { current: {} },
      });
      act(() => result.current.applyRecoveredTurn(SERVER, RECOVERED));

      expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-rec'] });
    });

    it('widens a marked project whose entry became empty (the user closed the only provisional thread) with the server list minus the closed ids', () => {
      const { restoredProjectsRef, provisionalEntries } = provisionalFirstEntry();
      provisionalEntries.noteClosed('project-a', 'sess-b');
      provisionalEntries.noteClosed('project-a', 'sess-new');
      // sess-new を閉じて [] になった。印は残っているので、この [] は利用者の記録ではなく仮のエントリ。
      writePersistedChatThreadState('project-a', { activeSessionIds: [] });
      const { result, params } = setup({
        restoredProjectsRef,
        provisionalEntries,
        openThreadIdsRef: { current: { 'project-a': [] } },
        selectedThreadIdsRef: { current: {} },
      });
      act(() => result.current.applyRecoveredTurn(SERVER, RECOVERED));

      expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-a', 'sess-rec'] });
      expect(provisionalEntries.isProvisional('project-a', readPersistedChatThreads()['project-a'])).toBe(false);
    });

    it('keeps an id the user reopened (noteReopened) in the widened open set on a recovery', () => {
      const { restoredProjectsRef, provisionalEntries } = provisionalFirstEntry();
      provisionalEntries.noteClosed('project-a', 'sess-b');
      provisionalEntries.noteReopened('project-a', 'sess-b');
      const { result, params } = setup({
        restoredProjectsRef,
        provisionalEntries,
        openThreadIdsRef: { current: { 'project-a': ['sess-new'] } },
        selectedThreadIdsRef: { current: { 'project-a': 'sess-new' } },
      });
      act(() => result.current.applyRecoveredTurn(SERVER, RECOVERED));

      expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-a', 'sess-b', 'sess-new', 'sess-rec'] });
    });

    it('marks the first entry an adoption writes before the project is restored', () => {
      const { result, params } = setup();
      act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
      expect(params.provisionalEntries.isProvisional('project-a', readPersistedChatThreads()['project-a'])).toBe(true);
      // bdboard-521p: 印は保存エントリにも立つ(リロード・パネルを閉じても残る)。
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-new'],
        selectedSessionId: 'sess-new',
        provisional: true,
      });
    });

    it('takes an adopted id off the closed ids, so a list that lands later does not subtract it', () => {
      const { result, params } = setup();
      params.provisionalEntries.markIfFirstEntry('project-a');
      params.provisionalEntries.noteClosed('project-a', 'sess-new');
      act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
      expect(params.provisionalEntries.closedIds('project-a').has('sess-new')).toBe(false);
      // bdboard-521p: 保存エントリの閉じた id からも外れ、印は残る。
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new', provisional: true,
      });
    });

    it('does not mark an adoption on a revisit (an entry already existed)', () => {
      writePersistedChatThreadState('project-a', { activeSessionIds: ['sess-1'], selectedSessionId: 'sess-1' });
      const { result, params } = setup();
      act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
      expect(params.provisionalEntries.isProvisional('project-a', readPersistedChatThreads()['project-a'])).toBe(false);
    });

    it('does not mark an adoption after the project is restored (an agent change\'s explicit empty, or E7)', () => {
      const { result, params } = setup({ restoredProjectsRef: { current: new Set(['project-a']) } });
      act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
      expect(params.provisionalEntries.isProvisional('project-a', readPersistedChatThreads()['project-a'])).toBe(false);
    });

    it('marks the first entry the dead-selected-session branch of handleHistorySessionGone writes before the project is restored', () => {
      const { result, params } = setup({
        selectedThreadIdsRef: { current: { 'project-a': 'sess-dead' } },
        openThreadIdsRef: { current: { 'project-a': ['sess-live', 'sess-dead'] } },
      });
      act(() => result.current.handleHistorySessionGone('sess-dead'));
      expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['sess-live'], provisional: true });
      expect(params.provisionalEntries.isProvisional('project-a', readPersistedChatThreads()['project-a'])).toBe(true);
    });

    it('keeps a marked project provisional when the dead selected session was its only open thread (empty entry)', () => {
      const { result, params } = setup({
        selectedThreadIdsRef: { current: { 'project-a': 'sess-dead' } },
        openThreadIdsRef: { current: { 'project-a': ['sess-dead'] } },
      });
      act(() => result.current.handleHistorySessionGone('sess-dead'));
      expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: [], provisional: true });
      expect(params.provisionalEntries.isProvisional('project-a', readPersistedChatThreads()['project-a'])).toBe(true);
    });

    it('does not mark the dead-selected-session write of a restored project', () => {
      const { result, params } = setup({
        restoredProjectsRef: { current: new Set(['project-a']) },
        selectedThreadIdsRef: { current: { 'project-a': 'sess-dead' } },
        openThreadIdsRef: { current: { 'project-a': ['sess-live', 'sess-dead'] } },
      });
      act(() => result.current.handleHistorySessionGone('sess-dead'));
      expect(params.provisionalEntries.isProvisional('project-a', readPersistedChatThreads()['project-a'])).toBe(false);
    });
  });

  describe('handleHistorySessionGone', () => {
    it('prunes the dead selected session, clears and persists the selection, and advances the draft nonce', () => {
      const { result, params } = setup({
        selectedThreadIdsRef: { current: { 'project-a': 'sess-dead' } },
        openThreadIdsRef: { current: { 'project-a': ['sess-live', 'sess-dead'] } },
      });
      act(() => result.current.handleHistorySessionGone('sess-dead'));

      expect(
        lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, { 'project-a': ['sess-live', 'sess-dead'] }),
      ).toEqual({ 'project-a': ['sess-live'] });
      expect(
        lastUpdate(params.setThreadLists as ReturnType<typeof vi.fn>, {
          'project-a': [thread('sess-live'), thread('sess-dead')],
        }),
      ).toEqual({ 'project-a': [thread('sess-live')] });
      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, { 'project-a': 'sess-dead' })).toEqual(
        { 'project-a': undefined },
      );
      const unchanged = { 'project-a': 'sess-other' };
      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, unchanged)).toBe(unchanged);
      // 未復元で最初のエントリなので仮のエントリ(bdboard-521p: 保存エントリにも印が付く)。
      expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['sess-live'], provisional: true });
      expect(params.advanceDraftNonceAfterSessionGone).toHaveBeenCalledWith('project-a');
    });

    it('only prunes when the dead session is not the selected one', () => {
      const { result, params } = setup({
        selectedThreadIdsRef: { current: { 'project-a': 'sess-live' } },
        openThreadIdsRef: { current: { 'project-a': ['sess-live', 'sess-dead'] } },
      });
      act(() => result.current.handleHistorySessionGone('sess-dead'));

      // bdboard-d7on: handleHistorySessionGone は openThreadIdsRef.current から
      // (updater の prev ではなく)直接プルーンするようになった。prev はもはや
      // 参照されないので、ここでは openThreadIdsRef.current と一致する現実的な
      // baseline を渡し、sess-dead だけが除かれ sess-live は残ることを確かめる。
      expect(
        lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {
          'project-a': ['sess-live', 'sess-dead'],
        }),
      ).toEqual({ 'project-a': ['sess-live'] });
      expect(params.setThreadLists).toHaveBeenCalledTimes(1);
      expect(params.setSelectedThreadIds).not.toHaveBeenCalled();
      expect(params.advanceDraftNonceAfterSessionGone).not.toHaveBeenCalled();
      expect(readPersistedChatThreads()).toEqual({});
    });

    describe('a dead id that is not the selected one (bdboard-v9tz)', () => {
      it('drops it from the persisted open list and keeps the selection', () => {
        writePersistedChatThreadState('project-a', { activeSessionIds: ['A', 'B'], selectedSessionId: 'A' });
        const { result, params } = setup({
          selectedThreadIdsRef: { current: { 'project-a': 'A' } },
          openThreadIdsRef: { current: { 'project-a': ['A', 'B'] } },
        });
        act(() => result.current.handleHistorySessionGone('B'));

        // メモリ側は今までどおり落ちる。永続化の側が食い違って ['A','B'] のまま残っていた。
        expect(params.openThreadIdsRef.current['project-a']).toEqual(['A']);
        expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['A'], selectedSessionId: 'A' });
        expect(params.selectedThreadIdsRef.current['project-a']).toBe('A');
        expect(params.setSelectedThreadIds).not.toHaveBeenCalled();
        expect(params.advanceDraftNonceAfterSessionGone).not.toHaveBeenCalled();
      });

      it('leaves the other persisted ids untouched, even when the project list is not restored and memory is empty', () => {
        writePersistedChatThreadState('project-a', { activeSessionIds: ['A', 'B', 'C'], selectedSessionId: 'C' });
        const { result } = setup({ selectedThreadIdsRef: { current: { 'project-a': 'C' } } });
        act(() => result.current.handleHistorySessionGone('B'));

        expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['A', 'C'], selectedSessionId: 'C' });
      });

      it('keeps the persisted selection while a draft is shown (bdboard-e5cz rule)', () => {
        writePersistedChatThreadState('project-a', { activeSessionIds: ['A', 'B'], selectedSessionId: 'A' });
        const { result } = setup({
          selectedThreadIdsRef: { current: {} },
          openThreadIdsRef: { current: { 'project-a': ['A', 'B'] } },
        });
        act(() => result.current.handleHistorySessionGone('B'));

        expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['A'], selectedSessionId: 'A' });
      });

      it('writes the live selection when the persisted one pointed at the dead id', () => {
        writePersistedChatThreadState('project-a', { activeSessionIds: ['A', 'B'], selectedSessionId: 'B' });
        const { result } = setup({
          selectedThreadIdsRef: { current: { 'project-a': 'A' } },
          openThreadIdsRef: { current: { 'project-a': ['A', 'B'] } },
        });
        act(() => result.current.handleHistorySessionGone('B'));

        expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['A'], selectedSessionId: 'A' });
      });

      it('clears the persisted selection while a draft is shown when it pointed at the dead id', () => {
        writePersistedChatThreadState('project-a', { activeSessionIds: ['A', 'B'], selectedSessionId: 'B' });
        const { result } = setup({
          selectedThreadIdsRef: { current: {} },
          openThreadIdsRef: { current: { 'project-a': ['A', 'B'] } },
        });
        act(() => result.current.handleHistorySessionGone('B'));

        expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['A'], selectedSessionId: undefined });
      });

      it('prefers the live selection over a different, still-open persisted one', () => {
        writePersistedChatThreadState('project-a', { activeSessionIds: ['A', 'B', 'C'], selectedSessionId: 'C' });
        const { result } = setup({
          selectedThreadIdsRef: { current: { 'project-a': 'A' } },
          openThreadIdsRef: { current: { 'project-a': ['A', 'B', 'C'] } },
        });
        act(() => result.current.handleHistorySessionGone('B'));

        expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['A', 'C'], selectedSessionId: 'A' });
      });

      it('does not write when the persisted open list never held the dead id, or when nothing is persisted', () => {
        writePersistedChatThreadState('project-a', { activeSessionIds: ['A'], selectedSessionId: 'A' });
        const setItem = vi.spyOn(Storage.prototype, 'setItem');
        const { result } = setup({
          selectedThreadIdsRef: { current: { 'project-a': 'A' } },
          openThreadIdsRef: { current: { 'project-a': ['A', 'B'] } },
        });
        act(() => result.current.handleHistorySessionGone('B'));
        expect(setItem).not.toHaveBeenCalled();
        expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['A'], selectedSessionId: 'A' });

        localStorage.clear();
        act(() => result.current.handleHistorySessionGone('B'));
        expect(setItem).not.toHaveBeenCalled();
        expect(readPersistedChatThreads()).toEqual({});
        setItem.mockRestore();
      });

      it('only touches the current project', () => {
        writePersistedChatThreadState('project-a', { activeSessionIds: ['A', 'B'], selectedSessionId: 'A' });
        writePersistedChatThreadState('project-b', { activeSessionIds: ['B', 'X'], selectedSessionId: 'X' });
        const { result } = setup({ selectedThreadIdsRef: { current: { 'project-a': 'A' } } });
        act(() => result.current.handleHistorySessionGone('B'));

        expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['A'], selectedSessionId: 'A' });
        expect(readPersistedChatThreads()['project-b']).toEqual({ activeSessionIds: ['B', 'X'], selectedSessionId: 'X' });
      });
    });

    it('keeps the callback identity across renders, so E12 does not restart its fetch', () => {
      const { result, rerender, params } = setup();
      const first = result.current.handleHistorySessionGone;
      rerender({ ...params, openThreads: ['sess-x'], selectedThreadIdsRef: { current: {} } });
      expect(result.current.handleHistorySessionGone).toBe(first);
    });

    // bdboard-gtv0: 死んだセッションを prune したあとに、prune より前に始まった一覧取得の応答が届いても、
    // そのセッションを一覧に戻さない(戻すと、閉じたスレッドの再オープン経路から死亡スレッドを選べてしまう)。
    describe('a list that started before the prune (bdboard-gtv0)', () => {
      it('does not bring the dead session back through a recovery hydrate that started before the prune', () => {
        const threadListOrder = createThreadListFetchOrder();
        const { result, params } = setup({
          selectedThreadIdsRef: { current: { 'project-a': 'sess-live' } },
          openThreadIdsRef: { current: { 'project-a': ['sess-live', 'sess-dead'] } },
          restoredProjectsRef: { current: new Set(['project-a']) },
          threadListOrder,
        });
        const seq = threadListOrder.begin('project-a');
        act(() => result.current.handleHistorySessionGone('sess-dead'));
        act(() =>
          result.current.applyRecoveredTurn([thread('sess-live'), thread('sess-dead'), thread('sess-rec')], RECOVERED, false, seq),
        );

        expect(lastUpdate(params.setThreadLists as ReturnType<typeof vi.fn>, {})).toEqual({
          'project-a': [thread('sess-live'), thread('sess-rec')],
        });
      });

      it('does not bring the dead session back through an adoption refresh that started before the prune, and admits it once', async () => {
        let resolveThreads: (threads: ChatThreadDto[]) => void = () => undefined;
        fetchChatThreadsMock.mockReturnValue(
          new Promise<ChatThreadDto[]>((resolve) => {
            resolveThreads = resolve;
          }),
        );
        const threadListOrder = createThreadListFetchOrder();
        const admit = vi.spyOn(threadListOrder, 'admit');
        const { result, params } = setup({
          selectedThreadIdsRef: { current: { 'project-a': 'sess-live' } },
          openThreadIdsRef: { current: { 'project-a': ['sess-live', 'sess-dead'] } },
          restoredProjectsRef: { current: new Set(['project-a']) },
          threadListOrder,
        });
        act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
        await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
        // 取り直しの途中で、履歴の取得が「セッションは死んでいる」と分かった。
        act(() => result.current.handleHistorySessionGone('sess-dead'));
        await act(async () => {
          resolveThreads([thread('sess-live'), thread('sess-dead'), thread('sess-new')]);
          await Promise.resolve();
        });

        expect(lastUpdate(params.setThreadLists as ReturnType<typeof vi.fn>, {})).toEqual({
          'project-a': [thread('sess-live'), thread('sess-new')],
        });
        // 取り直しは 1 fetch につき admit を 1 回だけ呼ぶ(同じ番号の二重 admit が起きない)。
        expect(admit.mock.calls.map((call) => call[1])).toEqual([1]);
      });

      it('trusts a list that started after the prune', () => {
        const threadListOrder = createThreadListFetchOrder();
        const { result, params } = setup({
          selectedThreadIdsRef: { current: { 'project-a': 'sess-live' } },
          openThreadIdsRef: { current: { 'project-a': ['sess-live', 'sess-dead'] } },
          restoredProjectsRef: { current: new Set(['project-a']) },
          threadListOrder,
        });
        threadListOrder.begin('project-a');
        act(() => result.current.handleHistorySessionGone('sess-dead'));
        // prune の後に始まった回収の一覧(省略 = いま始めた fetch)はサーバーが反映済みなので、応答のまま当てる。
        act(() => result.current.applyRecoveredTurn([thread('sess-live'), thread('sess-dead')], RECOVERED));

        expect(lastUpdate(params.setThreadLists as ReturnType<typeof vi.fn>, {})).toEqual({
          'project-a': [thread('sess-live'), thread('sess-dead')],
        });
      });
    });
  });

  describe('handleResumeDiscoveredSession', () => {
    it('seeds the conversation, opens and selects the session, and refreshes the thread list', async () => {
      vi.useFakeTimers({ now: 1_000, toFake: ['Date'] });
      const refreshed = [thread('sess-new', 'refreshed')];
      fetchChatThreadsMock.mockResolvedValue(refreshed);
      const historyRequestIdRef = { current: 4 };
      // bdboard-d7on: handleResumeDiscoveredSession はもう render 時点の
      // openThreads prop を読まない(E7 の初回 fetch 解決前は stale/[] になり
      // 得るため)。restoredProjectsRef が未マークのこのケースでは persisted
      // storage を基点にする — 「前回訪問で sess-1 を開いたまま永続化されている」
      // を再現する。
      writePersistedChatThreadState('project-a', {
        activeSessionIds: ['sess-1'],
        selectedSessionId: 'sess-1',
      });
      const { result, params } = setup({ historyRequestIdRef });
      act(() =>
        result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', [
          { role: 'user', text: 'with time', timestamp: '2026-08-16T11:00:00.000Z' },
          { role: 'assistant', text: 'without time' },
        ]),
      );

      expect(historyRequestIdRef.current).toBe(5);
      expect(params.setSelectedAgentId).toHaveBeenCalledWith('agent-b');
      expect(lastUpdate(params.setConversations as ReturnType<typeof vi.fn>, {})).toEqual({
        'sess-new': {
          sessionId: 'sess-new',
          agentId: 'agent-b',
          messages: [
            { role: 'user', text: 'with time', at: Date.parse('2026-08-16T11:00:00.000Z') },
            { role: 'assistant', text: 'without time', at: 1_001 },
          ],
        },
      });
      expect(lastUpdate(params.setHistoryLoadedFor as ReturnType<typeof vi.fn>, {})).toEqual({ 'sess-new': true });
      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, { other: ['x'] })).toEqual({
        other: ['x'],
        'project-a': ['sess-1', 'sess-new'],
      });
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-1', 'sess-new'],
        selectedSessionId: 'sess-new',
      });
      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': 'sess-new',
      });
      expect(params.cancelThreadConfirmDelete).toHaveBeenCalledOnce();
      expect(lastUpdate(params.setLoadingHistoryFor as ReturnType<typeof vi.fn>, 'sess-new')).toBeNull();
      expect(lastUpdate(params.setLoadingHistoryFor as ReturnType<typeof vi.fn>, 'sess-other')).toBe('sess-other');
      expect(fetchChatThreadsMock).toHaveBeenCalledWith('project-a');
      vi.useRealTimers();
      await waitFor(() => {
        expect(lastUpdate(params.setThreadLists as ReturnType<typeof vi.fn>, {})).toEqual({ 'project-a': refreshed });
      });
    });

    it('does not duplicate an already-open session', () => {
      // bdboard-d7on: 同上の理由で persisted storage に既存の open 状態を
      // 用意する(render prop の openThreads はもう読まれない)。
      writePersistedChatThreadState('project-a', {
        activeSessionIds: ['sess-new', 'sess-1'],
        selectedSessionId: 'sess-1',
      });
      const { result, params } = setup();
      act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': ['sess-new', 'sess-1'],
      });
    });

    it('bdboard-d7on: once the project is marked restored, bases the next open list on openThreadIdsRef (not persisted storage)', () => {
      // このプロジェクトは既に E7/applyRecoveredTurn 等で復元済み。持続化には
      // 古い('stale-persisted')値しか無いが、restoredProjectsRef が立っている
      // 間は openThreadIdsRef.current の方を信頼するべき — persisted の方は
      // in-flight の別経路から取り残された、参照すべきでない古い値かもしれない。
      writePersistedChatThreadState('project-a', {
        activeSessionIds: ['stale-persisted'],
        selectedSessionId: 'stale-persisted',
      });
      const { result, params } = setup({
        restoredProjectsRef: { current: new Set(['project-a']) },
        openThreadIdsRef: { current: { 'project-a': ['sess-live'] } },
      });
      act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': ['sess-live', 'sess-new'],
      });
      expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-live', 'sess-new'] });
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-live', 'sess-new'],
        selectedSessionId: 'sess-new',
      });
    });

    describe('thread-list fetch order (bdboard-z9mn)', () => {
      it('does not write a refresh that started before an already-applied list', async () => {
        let resolveThreads: (threads: ChatThreadDto[]) => void = () => undefined;
        fetchChatThreadsMock.mockReturnValue(
          new Promise<ChatThreadDto[]>((resolve) => {
            resolveThreads = resolve;
          }),
        );
        const threadListOrder = createThreadListFetchOrder();
        const { result, params } = setup({ threadListOrder });
        act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
        await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
        // 取り直しの途中で、あとから始まった別の取り直し(2 回目の採用など)の一覧が先に当たった。
        const later = threadListOrder.begin('project-a');
        expect(threadListOrder.admit('project-a', later, [thread('sess-new'), thread('sess-newer')])).toBeDefined();
        await act(async () => {
          resolveThreads([thread('sess-new')]);
          await Promise.resolve();
        });

        expect(params.setThreadLists).not.toHaveBeenCalled();
      });

      it('lays a rename made after the refresh started over the refreshed list', async () => {
        let resolveThreads: (threads: ChatThreadDto[]) => void = () => undefined;
        fetchChatThreadsMock.mockReturnValue(
          new Promise<ChatThreadDto[]>((resolve) => {
            resolveThreads = resolve;
          }),
        );
        const threadListOrder = createThreadListFetchOrder();
        const { result, params } = setup({ threadListOrder });
        act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
        await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
        threadListOrder.noteEntryWrite('project-a', thread('sess-new', 'renamed'), 'replace');
        await act(async () => {
          resolveThreads([thread('sess-new', 'old title')]);
          await Promise.resolve();
        });

        expect(lastUpdate(params.setThreadLists as ReturnType<typeof vi.fn>, {})).toEqual({
          'project-a': [thread('sess-new', 'renamed')],
        });
      });

      it('still prunes the persisted ids the server no longer lists when its own list is the stale one', async () => {
        writePersistedChatThreadState('project-a', {
          activeSessionIds: ['sess-dead', 'sess-1'],
          selectedSessionId: 'sess-1',
        });
        let resolveThreads: (threads: ChatThreadDto[]) => void = () => undefined;
        fetchChatThreadsMock.mockReturnValue(
          new Promise<ChatThreadDto[]>((resolve) => {
            resolveThreads = resolve;
          }),
        );
        const threadListOrder = createThreadListFetchOrder();
        const { result, params } = setup({ threadListOrder });
        act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
        await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
        const later = threadListOrder.begin('project-a');
        expect(threadListOrder.admit('project-a', later, [thread('sess-1'), thread('sess-new')])).toBeDefined();
        await act(async () => {
          resolveThreads([thread('sess-1'), thread('sess-new')]);
          await Promise.resolve();
        });

        expect(params.setThreadLists).not.toHaveBeenCalled();
        expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-1', 'sess-new'] });
      });
    });

    describe('adopting before the project list is restored (bdboard-oaak)', () => {
      // 未復元(restoredProjectsRef 未マーク)の採用は、同期的には永続化済みの
      // activeSessionIds を基点にするしかない(サーバー一覧はまだ無い)。その中に
      // サーバーがもう持たない id があると、一覧が届いた後も open に残り、
      // タイトルの引けない「(無題)」タブになる(採用が restoredProjectsRef を立てるので
      // E7 の応答は open を復元し直さない)。一覧が届いたら、復元の経路
      // (restoreThreadView)と同じ規則で、基点にした永続化 id のうち一覧に無いものを落とす。
      it('drops a persisted id the server no longer lists once the refreshed thread list arrives, and persists the pruned open list', async () => {
        writePersistedChatThreadState('project-a', {
          activeSessionIds: ['sess-dead', 'sess-1'],
          selectedSessionId: 'sess-1',
        });
        fetchChatThreadsMock.mockResolvedValue([thread('sess-1', 'live'), thread('sess-new', 'resumed')]);
        const { result, params } = setup();
        act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
        // 同期の段階では一覧が無いので、永続化 id をそのまま基点にする(従来どおり)。
        expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-dead', 'sess-1', 'sess-new'] });

        await waitFor(() => expect(params.setThreadLists).toHaveBeenCalled());
        await act(async () => {
          await Promise.resolve();
        });

        expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-1', 'sess-new'] });
        expect(params.selectedThreadIdsRef.current).toEqual({ 'project-a': 'sess-new' });
        expect(readPersistedChatThreads()['project-a']).toEqual({
          activeSessionIds: ['sess-1', 'sess-new'],
          selectedSessionId: 'sess-new',
        });
      });

      it('keeps the adopted session open even when the refreshed list does not contain it yet', async () => {
        writePersistedChatThreadState('project-a', {
          activeSessionIds: ['sess-dead', 'sess-1'],
          selectedSessionId: 'sess-1',
        });
        fetchChatThreadsMock.mockResolvedValue([thread('sess-1', 'live')]);
        const { result, params } = setup();
        act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));

        await waitFor(() => expect(params.setThreadLists).toHaveBeenCalled());
        await act(async () => {
          await Promise.resolve();
        });

        expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-1', 'sess-new'] });
        expect(readPersistedChatThreads()['project-a']).toEqual({
          activeSessionIds: ['sess-1', 'sess-new'],
          selectedSessionId: 'sess-new',
        });
      });

      it('does not drop a session opened after the adoption (it was never part of the persisted base)', async () => {
        writePersistedChatThreadState('project-a', {
          activeSessionIds: ['sess-dead', 'sess-1'],
          selectedSessionId: 'sess-1',
        });
        // 一覧の取得が走っている間に、別経路(送信成功など)が sess-fresh を open へ足した。
        // sess-fresh は採用時の基点(永続化 id)に含まれないので、一覧に載っていなくても落とさない。
        let resolveThreads: (threads: ChatThreadDto[]) => void = () => undefined;
        fetchChatThreadsMock.mockReturnValue(
          new Promise<ChatThreadDto[]>((resolve) => {
            resolveThreads = resolve;
          }),
        );
        const { result, params } = setup();
        act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
        act(() => {
          params.setOpenThreadIds((prev) => ({
            ...prev,
            'project-a': [...(prev['project-a'] ?? []), 'sess-fresh'],
          }));
        });

        await act(async () => {
          resolveThreads([thread('sess-1', 'live'), thread('sess-new', 'resumed')]);
          await Promise.resolve();
        });
        await waitFor(() => expect(params.setThreadLists).toHaveBeenCalled());

        expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-1', 'sess-new', 'sess-fresh'] });
      });

      it('moves the selection to the adopted session when the user selected an id that turned out to be dead', async () => {
        writePersistedChatThreadState('project-a', {
          activeSessionIds: ['sess-dead', 'sess-1'],
          selectedSessionId: 'sess-1',
        });
        let resolveThreads: (threads: ChatThreadDto[]) => void = () => undefined;
        fetchChatThreadsMock.mockReturnValue(
          new Promise<ChatThreadDto[]>((resolve) => {
            resolveThreads = resolve;
          }),
        );
        const { result, params } = setup();
        act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
        act(() => {
          params.setSelectedThreadIds((prev) => ({ ...prev, 'project-a': 'sess-dead' }));
        });

        await act(async () => {
          resolveThreads([thread('sess-1', 'live'), thread('sess-new', 'resumed')]);
          await Promise.resolve();
        });
        await waitFor(() => expect(params.setThreadLists).toHaveBeenCalled());

        expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-1', 'sess-new'] });
        expect(params.selectedThreadIdsRef.current).toEqual({ 'project-a': 'sess-new' });
        expect(readPersistedChatThreads()['project-a']).toEqual({
          activeSessionIds: ['sess-1', 'sess-new'],
          selectedSessionId: 'sess-new',
        });
      });

      it('moves the selection to the first remaining open thread when the adopted tab was closed before the refreshed list arrived', async () => {
        writePersistedChatThreadState('project-a', {
          activeSessionIds: ['sess-dead', 'sess-1'],
          selectedSessionId: 'sess-1',
        });
        let resolveThreads: (threads: ChatThreadDto[]) => void = () => undefined;
        fetchChatThreadsMock.mockReturnValue(
          new Promise<ChatThreadDto[]>((resolve) => {
            resolveThreads = resolve;
          }),
        );
        const { result, params } = setup();
        act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
        // 取り直しが届く前に採用したタブを閉じた: closeThread の代わりの選択は open の先頭 (死んだ id)。
        act(() => {
          params.setOpenThreadIds((prev) => ({ ...prev, 'project-a': ['sess-dead', 'sess-1'] }));
          params.setSelectedThreadIds((prev) => ({ ...prev, 'project-a': 'sess-dead' }));
        });

        await act(async () => {
          resolveThreads([thread('sess-1', 'live'), thread('sess-new', 'resumed')]);
          await Promise.resolve();
        });
        await waitFor(() => expect(params.setThreadLists).toHaveBeenCalled());

        expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-1'] });
        expect(params.selectedThreadIdsRef.current).toEqual({ 'project-a': 'sess-1' });
        expect(readPersistedChatThreads()['project-a']).toEqual({
          activeSessionIds: ['sess-1'],
          selectedSessionId: 'sess-1',
        });
      });

      it('does not prune anything when the project was already restored (the open list was filtered at restore time)', async () => {
        fetchChatThreadsMock.mockResolvedValue([thread('sess-new', 'resumed')]);
        const { result, params } = setup({
          restoredProjectsRef: { current: new Set(['project-a']) },
          openThreadIdsRef: { current: { 'project-a': ['sess-live'] } },
        });
        act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));

        await waitFor(() => expect(params.setThreadLists).toHaveBeenCalled());
        await act(async () => {
          await Promise.resolve();
        });

        expect(params.openThreadIdsRef.current).toEqual({ 'project-a': ['sess-live', 'sess-new'] });
      });
    });

    it('falls back to an explanatory note when there are no seed messages', () => {
      const { result, params } = setup();
      act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
      const conversations = lastUpdate(params.setConversations as ReturnType<typeof vi.fn>, {}) as Record<
        string,
        { messages: { role: string; text: string }[] }
      >;
      expect(conversations['sess-new'].messages).toEqual([
        expect.objectContaining({
          role: 'assistant',
          text: 'このCLIセッションの直近の会話をここに表示できませんでした。続きから会話できます。',
        }),
      ]);
    });

    it('swallows a failed thread-list refresh', async () => {
      fetchChatThreadsMock.mockRejectedValue(new Error('threads down'));
      const { result, params } = setup();
      act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
      await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
      await act(async () => {
        await Promise.resolve();
      });
      expect(params.setThreadLists).not.toHaveBeenCalled();
    });
  });
});
