/**
 * bdboard-3tw.104.11 Opus レビュー SF3(b): interface/http 層(chat-routes.ts のレート制限
 * ミドルウェア)と infrastructure 層(claude-spec.ts が宣言する実物の重み)を実際に組み合わせた
 * 結合テスト。
 *
 * chat-routes.test.ts に置くと `src/interface/**` から `src/infrastructure/**` を import する
 * ことになり、.dependency-cruiser.cjs の `interface-no-infrastructure` ルールに違反する
 * (dependency-cruiser はテストファイルもパス prefix で判定するため、`.test.ts` でも例外にはならない)。
 * main.ts と同じ「両層を配線するコンポジションルート」の立ち位置として、`src/` 直下
 * (interface/application/infrastructure/domain いずれの prefix にも属さない)に置くことで
 * この制約を回避しつつ、実物同士の結線を検証する。
 *
 * これが必要な理由: chat-routes.test.ts の既存テストは手組みの ChatAgentPort フェイクに
 * `descriptor.models[].weight` を直接埋め込んでいるため、「chat-routes.ts が registry から
 * 正しく weight を引けること」は検証できても、「claude-spec.ts が実際に宣言している重みと
 * chat-routes.ts の解決先が一致していること」までは保証しない。フェイクと実装が将来乖離しても
 * フェイク側のテストは黙って通り続けてしまう。
 */
import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { compareStrings } from './domain/compare.js';
import { makeTicket } from './domain/test-support.js';
import type { Project } from './domain/project.js';
import type { BoardCache, CachedProject } from './application/ports/board-cache.js';
import {
  createEmptyCfdCacheMethods,
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
} from './application/ports/board-cache-fakes.js';
import { createChatSessionStore } from './application/chat/chat-session-store.js';
import { createInMemoryChatMessageRepository } from './application/chat/in-memory-chat-message-repository.js';
import { createChatAgentRegistry } from './application/chat/chat-agent-registry.js';
import type { CommandResult, CommandRunner } from './application/ports/command-runner.js';
import { createChatRoutes } from './interface/http/chat-routes.js';
import type { WriteGuardDeps } from './interface/http/write-guard.js';
import { createClaudeChatAgent } from './infrastructure/chat/claude-chat-agent.js';

const NOW = new Date('2026-08-16T12:00:00.000Z');

function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
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

function createFakeBoardCache(entries: readonly CachedProject[] = []): BoardCache {
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

/** 9rz の書き込み開放と同じ条件が揃った状態(chat-routes.test.ts の authorizedDeps と同型)。 */
function authorizedDeps(): WriteGuardDeps {
  return {
    isTunnelWriteAllowed: () => true,
    hasTunnelSession: () => true,
  };
}

/** claude CLI を実際には起動しない。常に成功する定型 JSON を返すだけの CommandRunner。 */
function fakeClaudeCommandRunner(): CommandRunner {
  return {
    async run(): Promise<CommandResult> {
      return {
        stdout: JSON.stringify({
          result: 'ok',
          session_id: '550e8400-e29b-41d4-a716-446655440000',
        }),
        stderr: '',
        exitCode: 0,
      };
    },
  };
}

// cloudflared は 127.0.0.1 から接続するため、送信元アドレスだけではローカル直アクセスと
// トンネル経由を区別できない。CF-Ray ヘッダの有無で isLocalControlRequest がトンネル経由と
// 判定する(local-request.ts)ので、レート制限を実際に働かせるにはこの組み合わせが要る。
const TUNNEL_HEADERS = {
  'CF-Ray': 'abc123-NRT',
  Cookie: 'bdboard_tunnel_session=example-session-value',
  'Content-Type': 'application/json',
} as const;

const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

function buildApp(perDay: number, modelWeights?: { readonly opus?: number }): Hono {
  const registry = createChatAgentRegistry();
  registry.register(
    createClaudeChatAgent(fakeClaudeCommandRunner(), {
      claudePath: '/opt/claude',
      model: 'sonnet',
      ...(modelWeights !== undefined ? { modelWeights } : {}),
    }),
  );
  const cache = createFakeBoardCache([cachedProject(project('proj-a', '/projects/a'))]);

  return createChatRoutes({
    cache,
    agents: registry,
    store: createChatSessionStore(),
    messages: createInMemoryChatMessageRepository(),
    writeAccess: authorizedDeps(),
    rateLimit: { perMinute: 1000, perDay },
  });
}

async function post(app: Hono, body: unknown): Promise<Response> {
  return app.request(
    '/api/chat/message',
    { method: 'POST', headers: TUNNEL_HEADERS, body: JSON.stringify(body) },
    LOOPBACK_ENV,
  );
}

describe('chat rate limit integration with the real claude spec (bdboard-3tw.104.11 Opus review SF3(b))', () => {
  it('consumes the opus weight (5) declared by the real claude spec', async () => {
    const app = buildApp(9);
    const body = { projectId: 'proj-a', message: 'hi', model: 'opus' };

    expect((await post(app, body)).status).toBe(200);
    // 5 + 5 = 10 > 9 なので2回目は拒否される。weight が仮に default(1) に落ちていたら
    // 9回とも通ってしまう。
    expect((await post(app, body)).status).toBe(429);
  });

  it('consumes the sonnet weight (1) declared by the real claude spec', async () => {
    const app = buildApp(9);
    const body = { projectId: 'proj-a', message: 'hi', model: 'sonnet' };

    for (let i = 0; i < 9; i += 1) {
      expect((await post(app, body)).status).toBe(200);
    }
    expect((await post(app, body)).status).toBe(429);
  });

  it('reflects a claude-spec modelWeights override (as chat-agent-registry-builder.ts threads env vars) end-to-end', async () => {
    const app = buildApp(3, { opus: 2 });
    const body = { projectId: 'proj-a', message: 'hi', model: 'opus' };

    expect((await post(app, body)).status).toBe(200);
    // weight=2 なら 2+2=4 > perDay=3 で2回目は拒否。weight が既定の 5 のままなら1回目で
    // 既に拒否され、weight=1 なら3回目まで通ってしまうので、どちらの回帰も検出できる。
    expect((await post(app, body)).status).toBe(429);
  });
});
