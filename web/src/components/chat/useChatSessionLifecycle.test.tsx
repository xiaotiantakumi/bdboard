import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionMessagesDto, ChatThreadDto } from '../../api';
import { readPersistedChatThreads, writePersistedChatThreadState } from '../../chatThreadStorage';
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
  const params: UseChatSessionLifecycleParams = {
    selectedProjectId: 'project-a',
    selectedThreadIdsRef: { current: {} },
    draftNoncesRef: { current: {} },
    setSelectedThreadIds: vi.fn(),
    historyRequestIdRef: { current: 0 },
    setConversations: vi.fn(),
    setHistoryLoadedFor: vi.fn(),
    setLoadingHistoryFor: vi.fn(),
    setThreadModelIds: vi.fn(),
    openThreads: [],
    openThreadIdsRef: { current: {} },
    restoredProjectsRef: { current: new Set() },
    setThreadLists: vi.fn(),
    setOpenThreadIds: vi.fn(),
    setSelectedAgentId: vi.fn(),
    cancelThreadConfirmDelete: vi.fn(),
    advanceDraftNonceAfterSessionGone: vi.fn(),
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
      expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['sess-live'] });
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

    it('keeps the callback identity across renders, so E12 does not restart its fetch', () => {
      const { result, rerender, params } = setup();
      const first = result.current.handleHistorySessionGone;
      rerender({ ...params, openThreads: ['sess-x'], selectedThreadIdsRef: { current: {} } });
      expect(result.current.handleHistorySessionGone).toBe(first);
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
