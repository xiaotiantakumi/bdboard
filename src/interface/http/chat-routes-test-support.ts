// bdboard-sso1.31: chat-routes.test.ts の分割 (bdboard-sso1.17 の chat ルート
// モジュール分割に追随) で複数のリソース別テストファイルから共有される、非テストの
// ヘルパー/フィクスチャ置き場。中身 (withLocalHost/createFakeBoardCache/
// createFakeAgent/createApp 等) は元の chat-routes.test.ts から一字一句変更せず
// 移動しただけ (move only)。export の付与と、createApp の戻り値型注釈の維持
// (import 元が変わったための `Hono` 型 import 追加) のみ加えた。
import { vi } from 'vitest';
import type { Hono } from 'hono';
import { compareStrings } from '../../domain/compare.js';
import { makeTicket } from '../../domain/test-support.js';
import type { Project } from '../../domain/project.js';
import type { BoardCache, CachedProject } from '../../application/ports/board-cache.js';
import type { ChatSessionDiscoveryPort } from '../../application/ports/chat-session-discovery.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../../application/ports/board-cache-fakes.js';
import type { ChatAgentPort } from '../../application/ports/chat-agent.js';
import { createChatSessionStore } from '../../application/chat/chat-session-store.js';
import { createInMemoryChatMessageRepository } from '../../application/chat/in-memory-chat-message-repository.js';
import { createChatAgentRegistry } from '../../application/chat/chat-agent-registry.js';
import { createChatRoutes } from './chat-routes.js';
import type { WriteGuardDeps } from './write-guard.js';

export const LOCAL_HOST = 'localhost:8787';

export const LOCAL_ENV = {
  incoming: {
    socket: {
      remoteAddress: '127.0.0.1',
      localPort: 8787,
    },
  },
};

export function withLocalHost(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('Host')) {
    headers.set('Host', LOCAL_HOST);
  }
  return { ...init, headers };
}

export const NOW = new Date('2026-08-15T12:00:00.000Z');
export const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
export const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64');

export function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

export function createFakeBoardCache(
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
      return [...byId.values()].sort((a, b) =>
        compareStrings(a.project.rootPath, b.project.rootPath),
      );
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

export function cachedProject(proj: Project): CachedProject {
  return {
    project: proj,
    tickets: [makeTicket({ id: 'bdboard-1', projectId: proj.id })],
    fingerprint: `fp-${proj.id}`,
    fetchedAt: NOW,
  };
}

export function createFakeAgent(
  overrides: Partial<ChatAgentPort> = {},
): ChatAgentPort {
  return {
    descriptor: {
      id: 'test-agent',
      label: 'Test Agent',
      models: [{ id: 'sonnet', label: 'Sonnet' }],
      experimental: false,
      supportsStreaming: false,
      capability: 'bd-only',
    },
    checkAvailability: vi.fn(async () => 'available' as const),
    sendMessage: vi.fn(async () => ({
      reply: 'hello from agent',
      sessionId: '550e8400-e29b-41d4-a716-446655440099',
      failedTools: [],
      agentId: 'test-agent',
    })),
    ...overrides,
  };
}

export function createApp(
  overrides: {
    readonly cache?: BoardCache;
    readonly agent?: ChatAgentPort;
    readonly agents?: ReturnType<typeof createChatAgentRegistry>;
    readonly store?: ReturnType<typeof createChatSessionStore>;
    readonly messages?: ReturnType<typeof createInMemoryChatMessageRepository>;
    readonly writeAccess?: WriteGuardDeps;
    readonly now?: () => Date;
    readonly rateLimit?: {
      readonly perMinute?: number;
      readonly perDay?: number;
      readonly defaultWeight?: number;
    };
    readonly availabilityCacheMs?: number;
    readonly sessionDiscovery?: ChatSessionDiscoveryPort;
  } = {},
): Hono {
  const agents =
    overrides.agents ??
    (() => {
      const registry = createChatAgentRegistry();
      registry.register(overrides.agent ?? createFakeAgent());
      return registry;
    })();

  return createChatRoutes({
    cache: overrides.cache ?? createFakeBoardCache(),
    agents,
    store: overrides.store ?? createChatSessionStore(),
    messages: overrides.messages ?? createInMemoryChatMessageRepository(),
    ...(overrides.writeAccess !== undefined
      ? { writeAccess: overrides.writeAccess }
      : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    ...(overrides.rateLimit !== undefined ? { rateLimit: overrides.rateLimit } : {}),
    ...(overrides.availabilityCacheMs !== undefined
      ? { availabilityCacheMs: overrides.availabilityCacheMs }
      : {}),
    ...(overrides.sessionDiscovery !== undefined
      ? { sessionDiscovery: overrides.sessionDiscovery }
      : {}),
  });
}
