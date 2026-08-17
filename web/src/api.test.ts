import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  deleteChatThread,
  fetchChatThreads,
  LANE_EXPECTED_STATUS,
  LANE_LABELS,
  LANES,
  isLaneStatusMismatch,
  postChatMessageStream,
  putScanRootsConfig,
} from './api';

describe('LANES column order (bdboard-662)', () => {
  it('orders columns as 着手可能 → 進行中 → 確認待ち → ブロック → 完了, with no separate deferred lane', () => {
    expect(LANES).toEqual(['ready', 'in_progress', 'awaiting_human', 'blocked', 'done']);
  });

  it('has a label for every lane and no leftover deferred entry', () => {
    for (const lane of LANES) {
      expect(LANE_LABELS[lane]).toBeTruthy();
    }
    expect(Object.keys(LANE_LABELS).sort()).toEqual([...LANES].sort());
  });
});

describe('LANE_EXPECTED_STATUS (bdboard-662 blocked/deferred merge)', () => {
  it('treats a real deferred-status ticket sitting in the blocked lane as not mismatched', () => {
    expect(isLaneStatusMismatch('blocked', 'deferred')).toBe(false);
  });

  it('still flags a dependency-derived blocked card (status open) sitting in the blocked lane as mismatched', () => {
    expect(isLaneStatusMismatch('blocked', 'open')).toBe(true);
  });

  it('still flags a genuinely blocked-status ticket as matching the blocked lane', () => {
    expect(isLaneStatusMismatch('blocked', 'blocked')).toBe(false);
  });

  it('every expected-status list only references known Lane keys', () => {
    for (const lane of Object.keys(LANE_EXPECTED_STATUS)) {
      expect(LANES).toContain(lane);
    }
  });
});

describe('chat thread API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetchChatThreads encodes projectId and returns DTOs', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify([{ sessionId: 's1', agentId: 'claude', title: 'hello', updatedAt: '2026-01-01T00:00:00Z' }]))));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchChatThreads('project/a')).resolves.toEqual([
      { sessionId: 's1', agentId: 'claude', title: 'hello', updatedAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/threads?projectId=project%2Fa', undefined);
  });

  it('deleteChatThread sends DELETE with both identifiers', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(deleteChatThread('session/1', 'project/a')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions/session%2F1?projectId=project%2Fa', { method: 'DELETE' });
  });

  it('postChatMessageStream delivers deltas and returns done response', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"AB"}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"CD"}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: done\ndata: {"reply":"ABCD","sessionId":"s1","agentId":"claude"}\n\n'));
        controller.close();
      },
    }))));
    vi.stubGlobal('fetch', fetchMock);
    const onDelta = vi.fn();
    await expect(postChatMessageStream({ projectId: 'p', message: 'hello' }, { onDelta })).resolves.toEqual({
      reply: 'ABCD', sessionId: 's1', agentId: 'claude',
    });
    expect(onDelta.mock.calls).toEqual([['AB'], ['CD']]);
  });

  it('postChatMessageStream converts stream errors to ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: error\ndata: {"error":"chat failed","code":"agent-error","detail":"safe detail"}\n\n'));
        controller.close();
      },
    })))));
    await expect(postChatMessageStream({ projectId: 'p', message: 'hello' }, { onDelta: vi.fn() })).rejects.toMatchObject({
      status: 502, errorMessage: 'chat failed', code: 'agent-error', detail: 'safe detail',
    });
  });

  it('postChatMessageStream preserves non-2xx ApiError payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ error: 'busy', code: 'chat-busy', detail: 'try later' }),
      { status: 409, statusText: 'Conflict' },
    ))));
    await expect(postChatMessageStream({ projectId: 'p', message: 'hello' }, { onDelta: vi.fn() })).rejects.toMatchObject({
      status: 409, errorMessage: 'busy', code: 'chat-busy', detail: 'try later',
    });
  });
});

describe('scan roots config error details (bdboard-mmb review S2)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('putScanRootsConfig surfaces a 400 dangerous-scan-root response as ApiError.details.rejected', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: 'dangerous scan root rejected',
            details: { rejected: ['/etc', '/usr'] },
          }),
          { status: 400 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    let caught: unknown;
    try {
      await putScanRootsConfig({ scanRoots: ['/etc'], excludePaths: [], version: 'v1' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.errorMessage).toBe('dangerous scan root rejected');
    expect(apiError.details).toEqual({ rejected: ['/etc', '/usr'] });
  });
});
