import { describe, expect, it, vi } from 'vitest';
import type { CommentReader } from '../../application/ports/comment-reader.js';
import type { PrStatusReader, PrStatusResult } from '../../application/ports/pr-status-reader.js';
import { makeTicket } from '../../domain/test-support.js';
import { createApiRoutes } from './routes.js';
import { NOW, createDeps, createFakeBoardCache, project } from './routes-test-support.js';

// bdboard-p5l.27: GET /api/model-stats の complexityModel (複雑度 × 実装モデル × 修正 push 回数)。
// 要点は「リクエストの中で gh / bd を待たない」「/api/pr-links と PR キャッシュを共有する」
// 「gh が無い構成でも落ちない」の3つ。

const PR_URL = 'https://github.com/example/repo/pull/1';

function seed() {
  const cache = createFakeBoardCache();
  const proj = project('/a', '/projects/a');
  cache.putProject({
    project: proj,
    tickets: [
      makeTicket({
        id: 'bdboard-done',
        projectId: proj.id,
        closedAt: new Date('2026-05-30T10:00:00.000Z'),
        updatedAt: new Date('2026-05-30T11:00:00.000Z'),
        commentCount: 1,
        complexity: 'med',
        models: [{ stage: 'implement', model: 'composer-2.5' }],
      }),
      makeTicket({
        id: 'bdboard-unrecorded',
        projectId: proj.id,
        closedAt: new Date('2026-05-30T10:00:00.000Z'),
      }),
    ],
    fingerprint: 'fp',
    fetchedAt: NOW,
  });
  return cache;
}

const commentReader: CommentReader = {
  listComments: vi.fn(async (_root: string, issueId: string) => [
    {
      id: 'c1',
      issueId,
      author: 'agent',
      text: `PR: ${PR_URL}`,
      createdAt: new Date('2026-05-30T09:00:00.000Z'),
    },
  ]),
};

function statusReader(result: PrStatusResult): PrStatusReader {
  return { getPrStatus: vi.fn(async () => result) };
}

const MERGED_WITH_TWO: PrStatusResult = {
  status: { state: 'merged', checkStatus: 'pass', fixPushCount: 2 },
};

describe('GET /api/model-stats complexityModel (bdboard-p5l.27)', () => {
  it('returns the table without waiting for gh, flags the pending count, and fills in after the background warm', async () => {
    let releaseGh: (result: PrStatusResult) => void = () => {};
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(
        () =>
          new Promise<PrStatusResult>((resolve) => {
            releaseGh = resolve;
          }),
      ),
    };
    const app = createApiRoutes(createDeps({ cache: seed(), commentReader, prStatusReader }));

    // gh が応答しないままでもレスポンスは返る (リクエスト内で外部コマンドを待たない)。
    const first = await (await app.request('/api/model-stats?weeks=1')).json();

    expect(first.complexityModel).toEqual({
      rows: [
        {
          complexity: 'med',
          model: 'composer-2.5',
          ticketCount: 1,
          fixPushKnownCount: 0,
          fixPushTotal: 0,
          fixPushUnknownCount: 1,
          fixPushAverage: null,
        },
      ],
      unrecordedTicketCount: 1,
      fixPushPendingCount: 1,
    });

    // 先読みが gh に到達したら応答を返し、次の取得では確定値になる。
    await vi.waitFor(() => expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1));
    releaseGh(MERGED_WITH_TWO);
    await vi.waitFor(async () => {
      const body = await (await app.request('/api/model-stats?weeks=1')).json();
      expect(body.complexityModel.rows[0]).toMatchObject({
        fixPushKnownCount: 1,
        fixPushTotal: 2,
        fixPushAverage: 2,
        fixPushUnknownCount: 0,
      });
      expect(body.complexityModel.fixPushPendingCount).toBe(0);
    });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);
  });

  it('reuses the PR cache that /api/pr-links already warmed (no second gh call)', async () => {
    const prStatusReader = statusReader(MERGED_WITH_TWO);
    const app = createApiRoutes(createDeps({ cache: seed(), commentReader, prStatusReader }));

    const linksResponse = await app.request('/api/pr-links');
    expect(linksResponse.status).toBe(200);
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);

    const body = await (await app.request('/api/model-stats?weeks=1')).json();

    expect(body.complexityModel.rows[0]).toMatchObject({ fixPushKnownCount: 1, fixPushTotal: 2 });
    expect(body.complexityModel.fixPushPendingCount).toBe(0);
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);
  });

  it('counts the fix push count as unknown (not pending) when no gh/comment ports are wired', async () => {
    const app = createApiRoutes(createDeps({ cache: seed() }));

    const response = await app.request('/api/model-stats?weeks=1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.complexityModel.rows).toEqual([
      expect.objectContaining({ ticketCount: 1, fixPushKnownCount: 0, fixPushUnknownCount: 1 }),
    ]);
    expect(body.complexityModel.fixPushPendingCount).toBe(0);
  });

  it('keeps the existing weeklyCloses / stageModelDistribution fields', async () => {
    const app = createApiRoutes(createDeps({ cache: seed() }));

    const body = await (await app.request('/api/model-stats?weeks=1')).json();

    expect(body.weeklyCloses).toHaveLength(1);
    expect(body.stageModelDistribution).toEqual([
      { stage: 'implement', counts: { 'composer-2.5': 1 } },
    ]);
  });
});
