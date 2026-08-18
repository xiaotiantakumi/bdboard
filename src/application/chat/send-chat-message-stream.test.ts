import { describe, expect, it, vi } from 'vitest';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import type { ChatAgentPort } from '../ports/chat-agent.js';
import type { ChatMessageRepository } from '../ports/chat-message-repository.js';
import { createChatAgentRegistry } from './chat-agent-registry.js';
import { createChatSessionStore } from './chat-session-store.js';
import { resolveChatStreamTurn } from './send-chat-message-stream.js';

const cached = { project: { id: 'p', name: 'Project', rootPath: '/tmp/project', prefixes: [], aliasPaths: [] }, tickets: [], fingerprint: 'x', fetchedAt: new Date() } as CachedProject;
const cache = { getProject: (id: string) => id === 'p' ? cached : undefined } as BoardCache;
const messages = {} as ChatMessageRepository;

function agent(streaming: boolean, supportsImages = false): ChatAgentPort {
  return {
    descriptor: { id: 'test-agent', label: 'Test', experimental: false, capability: 'bd-only', models: [{ id: 'sonnet', label: 'Sonnet' }], supportsImages },
    checkAvailability: vi.fn(async () => 'available' as const),
    sendMessage: vi.fn(),
    ...(streaming ? { sendMessageStream: vi.fn(async () => ({ reply: '', sessionId: '', agentId: 'test-agent', failedTools: [] })) } : {}),
  };
}

function deps(agentPort: ChatAgentPort, store = createChatSessionStore()) {
  const agents = createChatAgentRegistry();
  agents.register(agentPort);
  return { cache, agents, store, messages };
}

describe('resolveChatStreamTurn', () => {
  it('resolves a streaming agent and builds the turn request', async () => {
    const store = createChatSessionStore();
    const result = await resolveChatStreamTurn(deps(agent(true), store), {
      projectId: 'p', message: '  hello  ', agentId: 'test-agent', sessionId: undefined, model: 'sonnet',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.handle.turnRequest).toEqual({ projectRootPath: '/tmp/project', projectName: 'Project', message: 'hello', model: 'sonnet' });
      result.handle.release();
    }
    expect(store.tryAcquire('p')).toBe(true);
    store.release('p');
  });

  it('returns streaming-not-supported and releases the lock', async () => {
    const store = createChatSessionStore();
    const result = await resolveChatStreamTurn(deps(agent(false), store), { projectId: 'p', message: 'hello' });
    expect(result).toEqual({ ok: false, failure: { kind: 'streaming-not-supported' } });
    expect(store.tryAcquire('p')).toBe(true);
    store.release('p');
  });

  it('propagates images to a streaming agent', async () => {
    const images = [{ mimeType: 'image/webp' as const, data: Uint8Array.from([1, 2]) }];
    const result = await resolveChatStreamTurn(deps(agent(true, true)), {
      projectId: 'p', message: 'look', images,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.handle.turnRequest.images).toBe(images);
      result.handle.release();
    }
  });

  it('rejects unsupported images before acquiring the project lock', async () => {
    const store = createChatSessionStore();
    const acquire = vi.spyOn(store, 'tryAcquire');
    const result = await resolveChatStreamTurn(deps(agent(true), store), {
      projectId: 'p',
      message: 'look',
      images: [{ mimeType: 'image/png', data: Uint8Array.from([1]) }],
    });
    expect(result).toEqual({ ok: false, failure: { kind: 'image-not-supported' } });
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each([
    ['project-not-found', { projectId: 'missing', message: 'hello' }],
    ['invalid-message', { projectId: 'p', message: '   ' }],
    ['unknown-agent', { projectId: 'p', message: 'hello', agentId: 'missing' }],
    ['unknown-model', { projectId: 'p', message: 'hello', model: 'missing' }],
  ])('propagates %s', async (kind, input) => {
    const result = await resolveChatStreamTurn(deps(agent(true)), input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe(kind);
  });
});
