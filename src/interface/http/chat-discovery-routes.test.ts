import { describe, expect, it, vi } from 'vitest';
import type { ChatSessionDiscoveryPort } from '../../application/ports/chat-session-discovery.js';
import { CHAT_SESSION_DISCOVERY_LOCAL_ONLY } from './chat-routes.js';
import {
  LOCAL_ENV,
  NOW,
  cachedProject,
  createApp,
  createFakeAgent,
  createFakeBoardCache,
  project,
  withLocalHost,
} from './chat-routes-test-support.js';

// bdboard-sso1.31: chat-routes.test.ts (chat ルート総合テスト) を実装側の chat
// ルートモジュール分割 (bdboard-sso1.17) に追随させて move-only 分割している最終
// PR (3/3)。元の 'chat sessionId validation and agentId (bdboard-l1t.2 step 2)'
// describe は、chat-message-routes.test.ts / chat-thread-routes.test.ts への
// 抽出後、discovered-sessions (list/adopt) の4テストのみが残っていた
// (bdboard-sso1.31 PR2/3 レビュー finding #1 で指摘: 説明的でないdescribe名の
// まま残存)。このファイルへ移す際に、実際の内容 (discovered-sessions の一覧/
// adopt) を正しく表す describe 名に変更した。テスト本体・期待値・モックの記述は
// 元の chat-routes.test.ts から一字一句変更していない。
describe('discovered-sessions routes (list/adopt) (bdboard-l1t.2 step 2)', () => {
  it('lists and adopts discovered sessions', async () => {
    const cache = createFakeBoardCache([cachedProject(project('proj-a', '/projects/a'))]);
    const discovery: ChatSessionDiscoveryPort = {
      listDiscoveredSessions: vi.fn(async () => [{ sessionId: 'session-1', lastActivityAt: NOW }]),
      verifySessionExists: vi.fn(async (_project, _projects, sessionId) => sessionId === 'session-1'),
      readAdoptSeedMessages: vi.fn(async (_project, _projects, sessionId) =>
        sessionId === 'session-1'
          ? [{ role: 'user' as const, text: 'seeded question', timestamp: NOW.toISOString() }]
          : undefined,
      ),
    };
    // bdboard-l1t.5 Opus レビュー SF6(b): discovery が発見するのは claude CLI の
    // トランスクリプトだけなので、adopt が受け付ける agentId も 'claude' 固定になった
    // (それ以外は登録済みでも拒否する)。そのためここでは agent の id を 'claude' にして
    // 登録する(以前は汎用の 'test-agent' を明示指定して adopt できたが、それ自体が
    // discovery の実体と矛盾する構成だったため許可しなくなった)。
    const app = createApp({
      cache,
      sessionDiscovery: discovery,
      agent: createFakeAgent({
        descriptor: { id: 'claude', label: 'Claude', models: [{ id: 'sonnet', label: 'Sonnet' }], experimental: false, capability: 'bd-only' },
      }),
    });
    const listed = await app.request('/api/chat/projects/proj-a/discovered-sessions', withLocalHost({}), LOCAL_ENV);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ sessions: [{ sessionId: 'session-1', lastActivityAt: NOW.toISOString(), alreadyAdopted: false }] });

    const adopted = await app.request(
      '/api/chat/projects/proj-a/discovered-sessions/session-1/adopt',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'claude' }),
      }),
      LOCAL_ENV,
    );
    expect(adopted.status).toBe(200);
    expect(await adopted.json()).toEqual({
      sessionId: 'session-1',
      agentId: 'claude',
      seedMessages: [{ role: 'user', text: 'seeded question', timestamp: NOW.toISOString() }],
    });
  });

  it('rejects adopt with a non-claude agentId even when that agent is registered (bdboard-l1t.5 Opus review SF6b)', async () => {
    const cache = createFakeBoardCache([cachedProject(project('proj-a', '/projects/a'))]);
    const discovery: ChatSessionDiscoveryPort = {
      listDiscoveredSessions: vi.fn(async () => [{ sessionId: 'session-1', lastActivityAt: NOW }]),
      verifySessionExists: vi.fn(async () => true),
      readAdoptSeedMessages: vi.fn(async () => []),
    };
    // 'test-agent' はデフォルトで登録されているが、discovery の実体が claude CLI
    // トランスクリプトである以上、登録済みであっても拒否されなければならない。
    const app = createApp({ cache, sessionDiscovery: discovery });
    const adopted = await app.request(
      '/api/chat/projects/proj-a/discovered-sessions/session-1/adopt',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'test-agent' }),
      }),
      LOCAL_ENV,
    );
    expect(adopted.status).toBe(400);
  });

  it('returns discovery availability and validation errors', async () => {
    const missing = await createApp().request('/api/chat/projects/proj-a/discovered-sessions', withLocalHost({}), LOCAL_ENV);
    expect(missing.status).toBe(501);
    const discovery: ChatSessionDiscoveryPort = {
      listDiscoveredSessions: vi.fn(async () => []),
      verifySessionExists: vi.fn(async () => true),
      readAdoptSeedMessages: vi.fn(async () => []),
    };
    const app = createApp({
      cache: createFakeBoardCache([cachedProject(project('proj-a', '/projects/a'))]),
      sessionDiscovery: discovery,
    });
    const unknown = await app.request('/api/chat/projects/nope/discovered-sessions', withLocalHost({}), LOCAL_ENV);
    expect(unknown.status).toBe(404);
    const invalid = await app.request('/api/chat/projects/proj-a/discovered-sessions/..s1/adopt', withLocalHost({ method: 'POST' }), LOCAL_ENV);
    expect(invalid.status).toBe(400);
    // N6: URL エンコードされた traversal 形式(`..%2f` = `../`)も、Hono のパスパラメータ
    // デコード後に同じ `includes('..')` チェックへ落ちて 400 になることを固定する。
    const encodedTraversal = await app.request(
      '/api/chat/projects/proj-a/discovered-sessions/..%2fsecret/adopt',
      withLocalHost({ method: 'POST' }),
      LOCAL_ENV,
    );
    expect(encodedTraversal.status).toBe(400);
  });

  // bdboard-3tw.104.3 レビュー MF1: 発見/adopt は通常の chatGuard (トンネル書き込み許可が
  // あれば通す) より厳しく常にローカル限定。トンネル利用者が自分で作っていない端末セッションの
  // トランスクリプトを閲覧・再開できてしまうため、当面ローカル限定。外部開放はユーザー裁定
  // チケット参照。トンネル書き込みが許可された状態でも 403 になることを固定する。
  it('keeps discovered-sessions and adopt local-only even when tunnel writes are otherwise authorized', async () => {
    const cache = createFakeBoardCache([cachedProject(project('proj-a', '/projects/a'))]);
    const discovery: ChatSessionDiscoveryPort = {
      listDiscoveredSessions: vi.fn(async () => [{ sessionId: 'session-1', lastActivityAt: NOW }]),
      verifySessionExists: vi.fn(async () => true),
      readAdoptSeedMessages: vi.fn(async () => []),
    };
    // bdboard-l1t.5 Opus レビュー SF6(b): adopt が受け付ける agentId は 'claude' 固定に
    // なったため、対照実験(下記 adoptedLocal)が 200 になるよう agent を 'claude' として登録する。
    const app = createApp({
      cache,
      sessionDiscovery: discovery,
      agent: createFakeAgent({
        descriptor: { id: 'claude', label: 'Claude', models: [{ id: 'sonnet', label: 'Sonnet' }], experimental: false, capability: 'bd-only' },
      }),
      writeAccess: {
        isTunnelWriteAllowed: () => true,
        hasTunnelSession: () => true,
      },
    });
    const tunnelHeaders = {
      'CF-Ray': 'abc123-NRT',
      Cookie: 'bdboard_tunnel_session=example-session-value',
      'Content-Type': 'application/json',
    };

    const listed = await app.request(
      '/api/chat/projects/proj-a/discovered-sessions',
      { headers: tunnelHeaders },
      LOCAL_ENV,
    );
    expect(listed.status).toBe(403);
    expect(discovery.listDiscoveredSessions).not.toHaveBeenCalled();
    // N2: 403 本文は専用の export 定数と一致する(リテラル文字列の重複を避ける)。
    expect(await listed.json()).toEqual({ error: CHAT_SESSION_DISCOVERY_LOCAL_ONLY });

    const adopted = await app.request(
      '/api/chat/projects/proj-a/discovered-sessions/session-1/adopt',
      { method: 'POST', headers: tunnelHeaders, body: '{}' },
      LOCAL_ENV,
    );
    expect(adopted.status).toBe(403);
    expect(discovery.verifySessionExists).not.toHaveBeenCalled();
    expect(await adopted.json()).toEqual({ error: CHAT_SESSION_DISCOVERY_LOCAL_ONLY });

    // 対照実験: 同じ経路がローカルなら通る(200)。
    const listedLocal = await app.request('/api/chat/projects/proj-a/discovered-sessions', withLocalHost({}), LOCAL_ENV);
    expect(listedLocal.status).toBe(200);
    const adoptedLocal = await app.request(
      '/api/chat/projects/proj-a/discovered-sessions/session-1/adopt',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'claude' }),
      }),
      LOCAL_ENV,
    );
    expect(adoptedLocal.status).toBe(200);
  });
});
