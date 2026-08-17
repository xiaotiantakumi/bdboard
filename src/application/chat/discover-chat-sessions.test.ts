import { describe, expect, it, vi } from 'vitest';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import type { ChatSessionDiscoveryPort } from '../ports/chat-session-discovery.js';
import { createChatAgentRegistry } from './chat-agent-registry.js';
import { createChatSessionStore } from './chat-session-store.js';
import { adoptChatSession, listDiscoveredChatSessions } from './discover-chat-sessions.js';
import type { Project } from '../../domain/project.js';

const p: Project = { id: 'p1', name: 'p1', rootPath: '/p1', prefixes: [], aliasPaths: [] };
const cached = { project: p, tickets: [], fingerprint: 'x', fetchedAt: new Date() } satisfies CachedProject;
function cache(entry: CachedProject | undefined = cached): BoardCache { return { getProject: () => entry, listProjects: () => entry === undefined ? [] : [entry] } as unknown as BoardCache; }
const SEED_MESSAGES = [{ role: 'user' as const, text: 'seeded question', timestamp: '2026-08-16T00:00:00.000Z' }];
function discovery(exists = true): ChatSessionDiscoveryPort {
  return {
    listDiscoveredSessions: vi.fn(async () => [{ sessionId: 's1', lastActivityAt: new Date(1) }]),
    verifySessionExists: vi.fn(async () => exists),
    readAdoptSeedMessages: vi.fn(async () => (exists ? SEED_MESSAGES : undefined)),
  };
}
// discovery が発見するトランスクリプトは常に claude CLI 由来なので、adopt の暗黙(agentId 省略)
// 解決先は 'claude' 固定であるべき (bdboard-3tw.104.3 レビュー S2)。
function agents() { const registry = createChatAgentRegistry(); registry.register({ descriptor: { id: 'claude', label: 'Claude', models: [], experimental: false, capability: 'bd-only' }, checkAvailability: vi.fn(async () => 'available' as const), sendMessage: vi.fn() }); return registry; }
// 'claude' が未登録の registry (S2 の loud-failure テスト用)。
function agentsWithoutClaude() { const registry = createChatAgentRegistry(); registry.register({ descriptor: { id: 'other-agent', label: 'Other', models: [], experimental: false, capability: 'bd-only' }, checkAvailability: vi.fn(async () => 'available' as const), sendMessage: vi.fn() }); return registry; }
function failureKind(result: Awaited<ReturnType<typeof adoptChatSession>>) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected failure');
  return result.failure.kind;
}

describe('discover chat sessions use-cases', () => {
  it('lists adoption status and reports missing projects', async () => {
    const store = createChatSessionStore(); store.remember('p1', 's1', 'claude');
    const result = await listDiscoveredChatSessions({ cache: cache(), discovery: discovery(), store }, 'p1');
    expect(result.ok && result.sessions[0].alreadyAdopted).toBe(true);
    const missingCache = { getProject: () => undefined, listProjects: () => [] } as unknown as BoardCache;
    expect((await listDiscoveredChatSessions({ cache: missingCache, discovery: discovery(), store }, 'p1')).ok).toBe(false);
  });
  it('adopts only an existing safe session, resolving to the claude agent and seeding messages (S2/M1)', async () => {
    const store = createChatSessionStore(); const d = discovery();
    expect(await adoptChatSession({ cache: cache(), discovery: d, store, agents: agents() }, { projectId: 'p1', sessionId: 's1' })).toEqual({
      ok: true,
      sessionId: 's1',
      agentId: 'claude',
      seedMessages: SEED_MESSAGES,
    });
    const remember = vi.spyOn(store, 'remember');
    expect(failureKind(await adoptChatSession({ cache: cache(), discovery: d, store, agents: agents() }, { projectId: 'p1', sessionId: '../s1' }))).toBe('invalid-session-id');
    expect(failureKind(await adoptChatSession({ cache: cache(), discovery: d, store, agents: agents() }, { projectId: 'p1', sessionId: '/s1' }))).toBe('invalid-session-id');
    expect(failureKind(await adoptChatSession({ cache: cache(), discovery: discovery(false), store, agents: agents() }, { projectId: 'p1', sessionId: 'missing' }))).toBe('unknown-session');
    expect(failureKind(await adoptChatSession({ cache: cache(), discovery: d, store, agents: agents() }, { projectId: 'p1', sessionId: 's1', agentId: 'nope' }))).toBe('unknown-agent');
    // すべての失敗経路 (invalid-session-id / unknown-session / unknown-agent) で
    // remember が一切呼ばれていないことを最後にまとめて確認する (bdboard-3tw.104.3 レビュー SF7)。
    expect(remember).not.toHaveBeenCalled();
  });
  it('rejects an explicit non-claude agentId even when that agent is registered (bdboard-l1t.5 Opus review SF6b)', async () => {
    const store = createChatSessionStore();
    const registry = createChatAgentRegistry();
    registry.register({ descriptor: { id: 'claude', label: 'Claude', models: [], experimental: false, capability: 'bd-only' }, checkAvailability: vi.fn(async () => 'available' as const), sendMessage: vi.fn() });
    registry.register({ descriptor: { id: 'cursor', label: 'Cursor', models: [], experimental: true, capability: 'unrestricted' }, checkAvailability: vi.fn(async () => 'available' as const), sendMessage: vi.fn() });
    const remember = vi.spyOn(store, 'remember');
    const result = await adoptChatSession(
      { cache: cache(), discovery: discovery(), store, agents: registry },
      { projectId: 'p1', sessionId: 's1', agentId: 'cursor' },
    );
    expect(failureKind(result)).toBe('unknown-agent');
    expect(!result.ok && result.failure.kind === 'unknown-agent' && result.failure.detail).toBe(
      'chat session discovery only supports the claude CLI agent',
    );
    expect(remember).not.toHaveBeenCalled();
  });
  it('fails loudly instead of picking an arbitrary agent when claude is not registered and agentId is omitted (S2)', async () => {
    const store = createChatSessionStore();
    const result = await adoptChatSession(
      { cache: cache(), discovery: discovery(), store, agents: agentsWithoutClaude() },
      { projectId: 'p1', sessionId: 's1' },
    );
    expect(failureKind(result)).toBe('unknown-agent');
    expect(!result.ok && result.failure.kind === 'unknown-agent' && result.failure.detail).toBe(
      'claude chat agent is not registered',
    );
  });
});
