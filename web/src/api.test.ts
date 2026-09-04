import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  acknowledgeChatTurn,
  deleteChatThread,
  fetchChatThreads,
  fetchChatTurnStatus,
  fetchHarnessPacks,
  fetchSimilarTickets,
  LANE_EXPECTED_STATUS,
  LANE_LABELS,
  LANES,
  isLaneStatusMismatch,
  postChatMessage,
  postChatMessageStream,
  postTicketDecision,
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
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify([{ sessionId: 's1', agentId: 'claude', title: 'hello', pinned: false, updatedAt: '2026-01-01T00:00:00Z' }]))));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchChatThreads('project/a')).resolves.toEqual([
      { sessionId: 's1', agentId: 'claude', title: 'hello', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/threads?projectId=project%2Fa', undefined);
  });

  it('fetchChatTurnStatus returns the server-side processing state', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ state: 'processing' }))),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchChatTurnStatus('project a')).resolves.toEqual({
      state: 'processing',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/turn-status?projectId=project+a',
      undefined,
    );
  });

  it('acknowledgeChatTurn deletes only the matching recovery marker', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(acknowledgeChatTurn('project/a', 'session 1')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/turn-status?projectId=project%2Fa&sessionId=session+1',
      { method: 'DELETE' },
    );
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

  it('includes image payloads in both non-streaming and streaming chat requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ reply: 'bulk', sessionId: 's1', agentId: 'claude' }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'event: done\ndata: {"reply":"stream","sessionId":"s2","agentId":"claude"}\n\n',
                ),
              );
              controller.close();
            },
          }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const images = [{ mimeType: 'image/png' as const, data: 'aW1hZ2U=' }];

    await postChatMessage({ projectId: 'p', message: 'bulk image', images });
    await postChatMessageStream(
      { projectId: 'p', message: 'stream image', images },
      { onDelta: vi.fn() },
    );

    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      projectId: 'p',
      message: 'bulk image',
      images,
    });
    expect(JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({
      projectId: 'p',
      message: 'stream image',
      images,
    });
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

describe('fetchHarnessPacks', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('surfaces a non-2xx response as ApiError', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: 'harness packs unavailable' }),
          { status: 503, statusText: 'Service Unavailable' },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    let caught: unknown;
    try {
      await fetchHarnessPacks();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(503);
    expect(apiError.errorMessage).toBe('harness packs unavailable');
    expect(fetchMock).toHaveBeenCalledWith('/api/harness/packs', undefined);
  });
});

describe('fetchSimilarTickets', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requests similar tickets with encoded ticket id and limit', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: 'bdboard-similar',
              projectId: 'proj-1',
              projectName: 'Alpha Project',
              title: 'Similar ticket detection',
              status: 'open',
              priority: 2,
              issueType: 'task',
              score: 0.8,
            },
          ]),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSimilarTickets('bdboard/target', 3)).resolves.toEqual([
      {
        id: 'bdboard-similar',
        projectId: 'proj-1',
        projectName: 'Alpha Project',
        title: 'Similar ticket detection',
        status: 'open',
        priority: 2,
        issueType: 'task',
        score: 0.8,
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tickets/bdboard%2Ftarget/similar?limit=3',
      undefined,
    );
  });
});

describe('postTicketDecision outcome normalization (bdboard-bh48)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserves unknown kind from the server response', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, outcome: { kind: 'unknown', closed: false } }),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(postTicketDecision('ticket-1', { freeform: 'retry later' })).resolves.toEqual({
      kind: 'unknown',
      closed: false,
    });
  });

  it('preserves gate kind from the server response', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, outcome: { kind: 'gate', closed: true } }),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(postTicketDecision('ticket-1', { choice: 'yes' })).resolves.toEqual({
      kind: 'gate',
      closed: true,
    });
  });

  it('falls unrecognized outcome kind values back to unknown', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, outcome: { kind: 'mystery', closed: false } }),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(postTicketDecision('ticket-1', { freeform: 'answer' })).resolves.toEqual({
      kind: 'unknown',
      closed: false,
    });
  });

  it('falls a missing outcome object back to unknown', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }))),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(postTicketDecision('ticket-1', { freeform: 'answer' })).resolves.toEqual({
      kind: 'unknown',
      closed: false,
    });
  });
});
