import { describe, expect, it, vi } from 'vitest';
import { CHAT_MESSAGE_MAX_LENGTH } from '../../domain/chat.js';
import { makeTicket } from '../../domain/test-support.js';
import type { Project } from '../../domain/project.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../ports/board-cache-fakes.js';
import {
  CHAT_FAILURE_MESSAGES,
  ChatAgentError,
  type ChatAgentPort,
  type ChatTurnResult,
} from '../ports/chat-agent.js';
import { createChatAgentRegistry } from './chat-agent-registry.js';
import { createInMemoryChatMessageRepository } from './in-memory-chat-message-repository.js';
import { createChatSessionStore } from './chat-session-store.js';
import { IMAGE_ONLY_CHAT_MESSAGE, sendChatMessage } from './send-chat-message.js';

const NOW = new Date('2026-08-15T12:00:00.000Z');

function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

function createFakeBoardCache(
  entries: readonly CachedProject[] = [],
): BoardCache {
  const byId = new Map(entries.map((entry) => [entry.project.id, entry]));

  return {
    getProject(projectId: string): CachedProject | undefined {
      return byId.get(projectId);
    },
    putProject(entry: CachedProject): void {
      byId.set(entry.project.id, entry);
    },
    listProjects(): readonly CachedProject[] {
      return [...byId.values()];
    },
    deleteProject(projectId: string): void {
      byId.delete(projectId);
    },
    clear(): void {
      byId.clear();
    },
    getTranscriptOffset(): number | undefined {
      return undefined;
    },
    setTranscriptOffset(): void {},
    addSessionUsage(): void {},
    getSessionUsage(): readonly never[] {
      return [];
    },
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...createEmptyInteractionsCacheMethods(),
    close(): void {},
  };
}

function cachedProject(proj: Project): CachedProject {
  return {
    project: proj,
    tickets: [makeTicket({ id: 'bdboard-1', projectId: proj.id })],
    fingerprint: `fp-${proj.id}`,
    fetchedAt: NOW,
  };
}

function createFakeAgent(
  id: string,
  overrides: Partial<ChatAgentPort> = {},
): ChatAgentPort {
  const sendMessage = vi
    .fn<ChatAgentPort['sendMessage']>()
    .mockResolvedValue({
      reply: 'ok',
      sessionId: 'new-session-id',
      failedTools: [],
      agentId: id,
    } satisfies ChatTurnResult);

  return {
    descriptor: {
      id,
      label: `Test Agent ${id}`,
      models: [{ id: 'sonnet', label: 'Sonnet' }],
      experimental: false,
      capability: 'bd-only',
    },
    checkAvailability: vi.fn(async () => 'available' as const),
    sendMessage,
    ...overrides,
  };
}

function createRegistryWithAgents(
  agents: readonly ChatAgentPort[],
): ReturnType<typeof createChatAgentRegistry> {
  const registry = createChatAgentRegistry();
  for (const agent of agents) {
    registry.register(agent);
  }
  return registry;
}

describe('sendChatMessage', () => {
  it('returns project-not-found when the project is missing', async () => {
    const result = await sendChatMessage(
      {
        cache: createFakeBoardCache(),
        agents: createRegistryWithAgents([createFakeAgent('test-agent')]),
        store: createChatSessionStore(),
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'missing', message: 'hello' },
    );

    expect(result).toEqual({ ok: false, failure: { kind: 'project-not-found' } });
  });

  it('returns invalid-message for empty or whitespace-only input', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([createFakeAgent('test-agent')]),
        store: createChatSessionStore(),
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: '   ' },
    );

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'invalid-message', detail: 'message is empty' },
    });
  });

  it('uses the fixed prompt for an image-only turn and propagates decoded bytes', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const images = [{ mimeType: 'image/png' as const, data: Uint8Array.from([1, 2, 3]) }];
    const supportedAgent = createFakeAgent('test-agent', {
      descriptor: {
        id: 'test-agent',
        label: 'Test Agent',
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        experimental: false,
        capability: 'bd-only',
        supportsImages: true,
      },
    });
    const messages = createInMemoryChatMessageRepository();

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([supportedAgent]),
        store: createChatSessionStore(),
        messages,
      },
      { projectId: 'proj-a', message: '   ', agentId: 'test-agent', images },
    );

    expect(result.ok).toBe(true);
    expect(supportedAgent.sendMessage).toHaveBeenCalledWith({
      projectRootPath: '/projects/a',
      projectName: 'proj-a',
      message: IMAGE_ONLY_CHAT_MESSAGE,
      images,
    });
    expect(messages.listBySession('new-session-id')[0]?.content).toBe(IMAGE_ONLY_CHAT_MESSAGE);
  });

  it('rejects images unsupported by the resolved agent before acquiring the project lock', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const unsupportedAgent = createFakeAgent('test-agent');
    const store = createChatSessionStore();
    const acquire = vi.spyOn(store, 'tryAcquire');

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([unsupportedAgent]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      {
        projectId: 'proj-a',
        message: 'look',
        images: [{ mimeType: 'image/png', data: Uint8Array.from([1]) }],
      },
    );

    expect(result).toEqual({ ok: false, failure: { kind: 'image-not-supported' } });
    expect(acquire).not.toHaveBeenCalled();
    expect(unsupportedAgent.sendMessage).not.toHaveBeenCalled();
  });

  it('returns invalid-message when the message exceeds the max length', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const tooLong = 'x'.repeat(CHAT_MESSAGE_MAX_LENGTH + 1);

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([createFakeAgent('test-agent')]),
        store: createChatSessionStore(),
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: tooLong },
    );

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'invalid-message', detail: 'message is too long' },
    });
  });

  it('returns unknown-session when sessionId is not known for the project', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([createFakeAgent('test-agent')]),
        store: createChatSessionStore(),
        messages: createInMemoryChatMessageRepository(),
      },
      {
        projectId: 'proj-a',
        message: 'hello',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      },
    );

    expect(result).toEqual({ ok: false, failure: { kind: 'unknown-session' } });
  });

  it('returns unknown-session when sessionId belongs to another project', async () => {
    const store = createChatSessionStore();
    store.remember(
      'proj-a',
      '550e8400-e29b-41d4-a716-446655440000',
      'test-agent',
    );

    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
      cachedProject(project('proj-b', '/projects/b')),
    ]);

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([createFakeAgent('test-agent')]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      {
        projectId: 'proj-b',
        message: 'hello',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      },
    );

    expect(result).toEqual({ ok: false, failure: { kind: 'unknown-session' } });
  });

  it('returns busy when the project lock is already held', async () => {
    const store = createChatSessionStore();
    store.tryAcquire('proj-a');

    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([createFakeAgent('test-agent')]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello' },
    );

    expect(result).toEqual({ ok: false, failure: { kind: 'busy' } });
  });

  it('maps ChatAgentError failed to agent-error', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const agent = createFakeAgent('test-agent', {
      sendMessage: vi.fn(async () => {
        throw new ChatAgentError('agent-exit-nonzero');
      }),
    });

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([agent]),
        store: createChatSessionStore(),
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello' },
    );

    expect(result).toEqual({
      ok: false,
      failure: {
        kind: 'agent-error',
        code: 'agent-exit-nonzero',
        detail: CHAT_FAILURE_MESSAGES['agent-exit-nonzero'],
      },
    });
  });

  it('maps a CLI that cannot start to agent-unavailable', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const agent = createFakeAgent('test-agent', {
      sendMessage: vi.fn(async () => {
        throw new ChatAgentError('agent-not-found');
      }),
    });

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([agent]),
        store: createChatSessionStore(),
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello' },
    );

    expect(result).toEqual({
      ok: false,
      failure: {
        kind: 'agent-unavailable',
        detail: CHAT_FAILURE_MESSAGES['agent-not-found'],
      },
    });
  });

  it('releases the lock even when sendMessage throws', async () => {
    const store = createChatSessionStore();
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const agent = createFakeAgent('test-agent', {
      sendMessage: vi.fn(async () => {
        throw new Error('unexpected');
      }),
    });

    await expect(
      sendChatMessage(
        {
          cache,
          agents: createRegistryWithAgents([agent]),
          store,
          messages: createInMemoryChatMessageRepository(),
        },
        { projectId: 'proj-a', message: 'hello' },
      ),
    ).rejects.toThrow('unexpected');

    expect(store.tryAcquire('proj-a')).toBe(true);
  });

  it('remembers the session id and returns the agent reply on success', async () => {
    const store = createChatSessionStore();
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const sendMessage = vi.fn<ChatAgentPort['sendMessage']>().mockResolvedValue({
      reply: 'done',
      sessionId: '550e8400-e29b-41d4-a716-446655440099',
      failedTools: [],
      agentId: 'test-agent',
    });
    const agent = createFakeAgent('test-agent', { sendMessage });

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([agent]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello' },
    );

    expect(result).toEqual({
      ok: true,
      reply: 'done',
      sessionId: '550e8400-e29b-41d4-a716-446655440099',
      agentId: 'test-agent',
    });
    expect(sendMessage).toHaveBeenCalledWith({
      projectRootPath: '/projects/a',
      projectName: 'proj-a',
      message: 'hello',
    });
    expect(store.lookup('proj-a', '550e8400-e29b-41d4-a716-446655440099')).toEqual(
      { agentId: 'test-agent' },
    );
    expect(store.tryAcquire('proj-a')).toBe(true);
  });

  it('surfaces failedTools when the agent reports failed tool calls (bdboard-l1t.4 MF3)', async () => {
    const store = createChatSessionStore();
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const sendMessage = vi.fn<ChatAgentPort['sendMessage']>().mockResolvedValue({
      reply: 'done',
      sessionId: '550e8400-e29b-41d4-a716-446655440099',
      failedTools: ['bd_ready', 'bd_close'],
      agentId: 'test-agent',
    });
    const agent = createFakeAgent('test-agent', { sendMessage });

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([agent]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello' },
    );

    expect(result).toEqual({
      ok: true,
      reply: 'done',
      sessionId: '550e8400-e29b-41d4-a716-446655440099',
      agentId: 'test-agent',
      failedTools: ['bd_ready', 'bd_close'],
    });
  });

  it('omits failedTools when the agent reports no failures', async () => {
    const store = createChatSessionStore();
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const sendMessage = vi.fn<ChatAgentPort['sendMessage']>().mockResolvedValue({
      reply: 'done',
      sessionId: '550e8400-e29b-41d4-a716-446655440099',
      failedTools: [],
      agentId: 'test-agent',
    });
    const agent = createFakeAgent('test-agent', { sendMessage });

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([agent]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello' },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && 'failedTools' in result).toBe(false);
  });

  it('surfaces agentWarnings when the agent reports operational warnings (bdboard-l1t.6 N-e)', async () => {
    const store = createChatSessionStore();
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const sendMessage = vi.fn<ChatAgentPort['sendMessage']>().mockResolvedValue({
      reply: 'partial',
      sessionId: '550e8400-e29b-41d4-a716-446655440099',
      failedTools: [],
      agentWarnings: [
        'headless auto-deny: some tool call(s) were soft-denied mid-turn',
      ],
      agentId: 'test-agent',
    });
    const agent = createFakeAgent('test-agent', { sendMessage });

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([agent]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello' },
    );

    expect(result).toEqual({
      ok: true,
      reply: 'partial',
      sessionId: '550e8400-e29b-41d4-a716-446655440099',
      agentId: 'test-agent',
      agentWarnings: [
        'headless auto-deny: some tool call(s) were soft-denied mid-turn',
      ],
    });
  });

  it('persists agentWarnings on the assistant message when present (bdboard-l1t.6 N-e)', async () => {
    const store = createChatSessionStore();
    const messages = createInMemoryChatMessageRepository();
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const agent = createFakeAgent('test-agent', {
      sendMessage: vi.fn<ChatAgentPort['sendMessage']>().mockResolvedValue({
        reply: 'partial',
        sessionId: '550e8400-e29b-41d4-a716-446655440099',
        failedTools: [],
        agentWarnings: [
          'headless auto-deny: some tool call(s) were soft-denied mid-turn',
        ],
        agentId: 'test-agent',
      }),
    });

    await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([agent]),
        store,
        messages,
      },
      { projectId: 'proj-a', message: 'hello' },
    );

    expect(messages.listBySession('550e8400-e29b-41d4-a716-446655440099')).toEqual([
      { role: 'user', content: 'hello', createdAt: expect.any(Date) },
      {
        role: 'assistant',
        content: 'partial',
        createdAt: expect.any(Date),
        agentWarnings: [
          'headless auto-deny: some tool call(s) were soft-denied mid-turn',
        ],
      },
    ]);
  });

  it('omits agentWarnings when the agent reports none (bdboard-l1t.6 N-e)', async () => {
    const store = createChatSessionStore();
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const sendMessage = vi.fn<ChatAgentPort['sendMessage']>().mockResolvedValue({
      reply: 'done',
      sessionId: '550e8400-e29b-41d4-a716-446655440099',
      failedTools: [],
      agentId: 'test-agent',
    });
    const agent = createFakeAgent('test-agent', { sendMessage });

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([agent]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello' },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && 'agentWarnings' in result).toBe(false);
  });

  it('persists user and assistant messages for the session on success', async () => {
    const store = createChatSessionStore();
    const messages = createInMemoryChatMessageRepository();
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const agent = createFakeAgent('test-agent', {
      sendMessage: vi.fn<ChatAgentPort['sendMessage']>().mockResolvedValue({
        reply: 'assistant says hi',
        sessionId: '550e8400-e29b-41d4-a716-446655440099',
        failedTools: [],
        agentId: 'test-agent',
      }),
    });

    await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([agent]),
        store,
        messages,
      },
      { projectId: 'proj-a', message: 'user says hi' },
    );

    expect(messages.listBySession('550e8400-e29b-41d4-a716-446655440099')).toEqual([
      { role: 'user', content: 'user says hi', createdAt: expect.any(Date) },
      {
        role: 'assistant',
        content: 'assistant says hi',
        createdAt: expect.any(Date),
      },
    ]);
  });

  it('uses the default agent when agentId is omitted on a new turn', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const defaultAgent = createFakeAgent('claude');
    const otherAgent = createFakeAgent('codex');

    await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([defaultAgent, otherAgent]),
        store: createChatSessionStore(),
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello' },
    );

    expect(defaultAgent.sendMessage).toHaveBeenCalled();
    expect(otherAgent.sendMessage).not.toHaveBeenCalled();
  });

  it('uses the explicitly specified agent on a new turn', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const defaultAgent = createFakeAgent('claude');
    const codexAgent = createFakeAgent('codex');

    await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([defaultAgent, codexAgent]),
        store: createChatSessionStore(),
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello', agentId: 'codex' },
    );

    expect(codexAgent.sendMessage).toHaveBeenCalled();
    expect(defaultAgent.sendMessage).not.toHaveBeenCalled();
  });

  it('returns unknown-agent for an unknown agentId without calling sendMessage', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const agent = createFakeAgent('claude');

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([agent]),
        store: createChatSessionStore(),
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello', agentId: 'missing-agent' },
    );

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'unknown-agent', detail: 'unknown chat agent' },
    });
    expect(agent.sendMessage).not.toHaveBeenCalled();
  });

  it('returns unknown-agent when the registry is empty', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);

    const result = await sendChatMessage(
      {
        cache,
        agents: createChatAgentRegistry(),
        store: createChatSessionStore(),
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello' },
    );

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'unknown-agent', detail: 'no chat agent is registered' },
    });
  });

  it('uses the recorded agent on resume even when agentId is omitted', async () => {
    const store = createChatSessionStore();
    store.remember(
      'proj-a',
      '550e8400-e29b-41d4-a716-446655440000',
      'codex',
    );

    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const claudeAgent = createFakeAgent('claude');
    const codexAgent = createFakeAgent('codex');

    await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([claudeAgent, codexAgent]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      {
        projectId: 'proj-a',
        message: 'hello',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      },
    );

    expect(codexAgent.sendMessage).toHaveBeenCalled();
    expect(claudeAgent.sendMessage).not.toHaveBeenCalled();
  });

  it('returns agent-mismatch when resume agentId disagrees with the record', async () => {
    const store = createChatSessionStore();
    store.remember(
      'proj-a',
      '550e8400-e29b-41d4-a716-446655440000',
      'claude',
    );

    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const claudeAgent = createFakeAgent('claude');
    const codexAgent = createFakeAgent('codex');

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([claudeAgent, codexAgent]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      {
        projectId: 'proj-a',
        message: 'hello',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        agentId: 'codex',
      },
    );

    expect(result).toEqual({
      ok: false,
      failure: {
        kind: 'agent-mismatch',
        detail: 'session belongs to agent claude',
      },
    });
    expect(claudeAgent.sendMessage).not.toHaveBeenCalled();
    expect(codexAgent.sendMessage).not.toHaveBeenCalled();
  });

  it('succeeds on resume when request agentId matches the record', async () => {
    const store = createChatSessionStore();
    store.remember(
      'proj-a',
      '550e8400-e29b-41d4-a716-446655440000',
      'claude',
    );

    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const claudeAgent = createFakeAgent('claude', {
      sendMessage: vi.fn(async () => ({
        reply: 'resumed',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        failedTools: [],
        agentId: 'claude',
      })),
    });
    const codexAgent = createFakeAgent('codex');

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([claudeAgent, codexAgent]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      {
        projectId: 'proj-a',
        message: 'hello',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        agentId: 'claude',
      },
    );

    expect(result).toEqual({
      ok: true,
      reply: 'resumed',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      agentId: 'claude',
    });
    expect(claudeAgent.sendMessage).toHaveBeenCalled();
    expect(codexAgent.sendMessage).not.toHaveBeenCalled();
  });

  it('does not leave the lock held after failure cases', async () => {
    const store = createChatSessionStore();
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const agent = createFakeAgent('test-agent', {
      sendMessage: vi.fn(async () => {
        throw new ChatAgentError('agent-exit-nonzero');
      }),
    });

    await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([agent]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello' },
    );

    expect(store.tryAcquire('proj-a')).toBe(true);
  });

  it('returns unknown-model for a model outside the agent allowlist without calling sendMessage', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const store = createChatSessionStore();
    const tryAcquire = vi.spyOn(store, 'tryAcquire');
    const sendMessage = vi.fn<ChatAgentPort['sendMessage']>();
    const agent = createFakeAgent('claude', {
      descriptor: {
        id: 'claude',
        label: 'Claude',
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
        experimental: false,
        capability: 'bd-only',
      },
      sendMessage,
    });

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([agent]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello', model: 'haiku' },
    );

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'unknown-model', detail: 'unknown chat model' },
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(tryAcquire).not.toHaveBeenCalled();
  });

  // fail-closed の要。models を宣言しないエージェントは「モデル選択に対応しない」であって
  // 「何でも通す」ではない。ここが緩むと任意の文字列が claude --model <argv> に届く。
  it('rejects any model for an agent that declares no models', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const store = createChatSessionStore();
    const tryAcquire = vi.spyOn(store, 'tryAcquire');
    const sendMessage = vi.fn<ChatAgentPort['sendMessage']>();
    const agent = createFakeAgent('legacy', {
      descriptor: {
        id: 'legacy',
        label: 'Legacy',
        experimental: false,
        capability: 'bd-only',
      },
      sendMessage,
    });

    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([agent]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello', model: 'sonnet' },
    );

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'unknown-model', detail: 'unknown chat model' },
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(tryAcquire).not.toHaveBeenCalled();
  });

  it('passes an allowed model to the agent port', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const sendMessage = vi.fn<ChatAgentPort['sendMessage']>().mockResolvedValue({
      reply: 'ok',
      sessionId: 'new-session-id',
      failedTools: [],
      agentId: 'claude',
      model: 'opus',
    });
    const agent = createFakeAgent('claude', {
      descriptor: {
        id: 'claude',
        label: 'Claude',
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
        experimental: false,
        capability: 'bd-only',
      },
      sendMessage,
    });

    const store = createChatSessionStore();
    const result = await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([agent]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello', model: 'opus' },
    );

    expect(result).toEqual({
      ok: true,
      reply: 'ok',
      sessionId: 'new-session-id',
      agentId: 'claude',
      model: 'opus',
    });
    expect(sendMessage).toHaveBeenCalledWith({
      projectRootPath: '/projects/a',
      projectName: 'proj-a',
      message: 'hello',
      model: 'opus',
    });
    expect(store.lookup('proj-a', 'new-session-id')).toEqual({
      agentId: 'claude',
      model: 'opus',
    });
  });

  it('persists the input model when the turn result omits one', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const store = createChatSessionStore();
    const agent = createFakeAgent('claude', {
      descriptor: {
        id: 'claude', label: 'Claude', model: 'sonnet',
        models: [{ id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }],
        experimental: false, capability: 'bd-only',
      },
      sendMessage: vi.fn<ChatAgentPort['sendMessage']>().mockResolvedValue({
        reply: 'ok', sessionId: 'new-session-id', failedTools: [], agentId: 'claude',
      }),
    });

    await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([agent]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello', model: 'opus' },
    );

    expect(store.lookup('proj-a', 'new-session-id')).toEqual({
      agentId: 'claude', model: 'opus',
    });
  });

  it('persists the UI selector model id, not the CLI-reported raw model id, when both are present', async () => {
    // MF1: turnResult.model is the CLI's raw billed model id (e.g. 'claude-sonnet-5'),
    // which never matches ChatAgentDto.models[].id ('sonnet'/'opus') used for restore
    // validation on the client. The selector id the user actually chose (input.model)
    // must win so a later restore-and-validate against agent.models succeeds.
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const store = createChatSessionStore();
    const agent = createFakeAgent('claude', {
      descriptor: {
        id: 'claude', label: 'Claude', model: 'sonnet',
        models: [{ id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }],
        experimental: false, capability: 'bd-only',
      },
      sendMessage: vi.fn<ChatAgentPort['sendMessage']>().mockResolvedValue({
        reply: 'ok',
        sessionId: 'new-session-id',
        failedTools: [],
        agentId: 'claude',
        model: 'claude-sonnet-5',
      }),
    });

    await sendChatMessage(
      {
        cache,
        agents: createRegistryWithAgents([agent]),
        store,
        messages: createInMemoryChatMessageRepository(),
      },
      { projectId: 'proj-a', message: 'hello', model: 'opus' },
    );

    expect(store.lookup('proj-a', 'new-session-id')).toEqual({
      agentId: 'claude', model: 'opus',
    });
  });
});
