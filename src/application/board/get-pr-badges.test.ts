import { describe, expect, it, vi } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import {
  createEmptyCfdCacheMethods,
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
} from '../ports/board-cache-fakes.js';
import type { CommentReader } from '../ports/comment-reader.js';
import { BdError } from '../ports/issue-repository.js';
import type { PrStatus } from '../../domain/pr-link.js';
import type { PrStatusReader } from '../ports/pr-status-reader.js';
import { getPrBadges, PrBadgeCommentCache, PrBadgeStatusCache } from './get-pr-badges.js';

function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

function createFakeBoardCache(): BoardCache & { readonly entries: Map<string, CachedProject> } {
  const entries = new Map<string, CachedProject>();

  return {
    entries,
    getProject(projectId: string): CachedProject | undefined {
      return entries.get(projectId);
    },
    putProject(entry: CachedProject): void {
      entries.set(entry.project.id, entry);
    },
    listProjects(): readonly CachedProject[] {
      return [...entries.values()].sort((a, b) =>
        compareStrings(a.project.rootPath, b.project.rootPath),
      );
    },
    deleteProject(projectId: string): void {
      entries.delete(projectId);
    },
    clear(): void {
      entries.clear();
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

const PR_URL = 'https://github.com/xiaotiantakumi/bdboard/pull/99';

function makeManyProjectTickets(count: number): {
  readonly cache: BoardCache & { readonly entries: Map<string, CachedProject> };
  readonly urls: readonly string[];
} {
  const cache = createFakeBoardCache();
  const a = project('proj-a', '/projects/a');
  const updatedAt = new Date('2026-06-01T12:00:00.000Z');
  const urls = Array.from(
    { length: count },
    (_, index) => `https://github.com/xiaotiantakumi/bdboard/pull/${900 + index}`,
  );
  cache.putProject({
    project: a,
    tickets: Array.from({ length: count }, (_, index) =>
      makeTicket({ id: `bdboard-rl-${index}`, projectId: a.id, commentCount: 1, updatedAt }),
    ),
    fingerprint: 'fp-a',
    fetchedAt: updatedAt,
  });
  return { cache, urls };
}

function commentReaderForUrls(
  tickets: readonly { readonly id: string }[],
  urls: readonly string[],
): CommentReader {
  const urlByTicketId = new Map(tickets.map((ticket, index) => [ticket.id, urls[index]]));
  return {
    listComments: vi.fn(async (_rootPath: string, issueId: string) => [
      {
        id: 'c1',
        issueId,
        author: 'agent',
        text: `PR: ${urlByTicketId.get(issueId)}`,
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
      },
    ]),
  };
}


describe('getPrBadges', () => {
  it('returns badges with status when comments and gh lookup succeed', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-pr',
          projectId: a.id,
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => [
        {
          id: 'c1',
          issueId: 'bdboard-pr',
          author: 'agent',
          text: `PR: ${PR_URL}`,
          createdAt: new Date('2026-06-01T12:00:00.000Z'),
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () =>
        ({ status: { state: 'open', checkStatus: 'pass' } satisfies PrStatus }),
      ),
    };

    const badges = await getPrBadges(cache, commentReader, prStatusReader);

    expect(badges).toEqual([
      {
        ticketId: 'bdboard-pr',
        projectId: 'proj-a',
        url: PR_URL,
        status: { state: 'open', checkStatus: 'pass' },
      },
    ]);
  });

  it('skips commentReader for tickets with commentCount zero', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-no-comments',
          projectId: a.id,
          commentCount: 0,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => []),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'other' }) as const),
    };

    const badges = await getPrBadges(cache, commentReader, prStatusReader);

    expect(badges).toEqual([]);
    expect(commentReader.listComments).not.toHaveBeenCalled();
  });

  it('continues when listComments throws for one ticket', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const b = project('proj-b', '/projects/b');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-broken',
          projectId: a.id,
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });
    cache.putProject({
      project: b,
      tickets: [
        makeTicket({
          id: 'bdboard-ok',
          projectId: b.id,
          commentCount: 2,
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (rootPath) => {
        if (rootPath === '/projects/a') {
          throw new BdError('unknown', 'bdboard-broken', 'bd failed');
        }
        return [
          {
            id: 'c1',
            issueId: 'bdboard-ok',
            author: 'agent',
            text: `PR: ${PR_URL}`,
            createdAt: new Date('2026-06-01T12:00:00.000Z'),
          },
        ];
      }),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () =>
        ({ status: { state: 'merged', checkStatus: 'pass' } satisfies PrStatus }),
      ),
    };

    const logWarn = vi.fn();
    const badges = await getPrBadges(cache, commentReader, prStatusReader, {
      logWarn,
    });

    expect(badges).toEqual([
      {
        ticketId: 'bdboard-ok',
        projectId: 'proj-b',
        url: PR_URL,
        status: { state: 'merged', checkStatus: 'pass' },
      },
    ]);
    // 黙って飛ばすと「バッジが出ない」理由を追う手掛かりがゼロになる
    // (bdboard-fxxk)。件数・分母・代表の失敗が1行に入っていること。
    expect(logWarn).toHaveBeenCalledTimes(1);
    const message = logWarn.mock.calls[0]?.[0] as string;
    expect(message).toContain('1 of 2 failed');
    expect(message).toContain('bdboard-broken');
    expect(message).toContain('bd failed');
  });

  it('warns separately when the PR status lookup throws', async () => {
    // コメントは読めているのでバッジ自体は出る。状態だけが引けない (gh 未認証など) の
    // は劣化であって失敗ではないが、原因は残す。
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'bdboard-a', projectId: a.id, commentCount: 1 }),
        // PR コメントの無いチケット。状態を引きにいく件数 (1) と、コメントを
        // 引いた件数 (2) をずらして、分母の取り違えを検出できるようにする。
        makeTicket({ id: 'bdboard-nopr', projectId: a.id, commentCount: 1 }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_rootPath: string, issueId: string) => [
        {
          id: 'c1',
          issueId,
          author: 'agent',
          text: issueId === 'bdboard-a' ? `PR: ${PR_URL}` : 'ただのコメント',
          createdAt: new Date('2026-06-01T12:00:00.000Z'),
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => {
        throw new Error('gh not authenticated');
      }),
    };

    const logWarn = vi.fn();
    const badges = await getPrBadges(cache, commentReader, prStatusReader, {
      logWarn,
    });

    expect(badges).toEqual([
      { ticketId: 'bdboard-a', projectId: 'proj-a', url: PR_URL, status: null },
    ]);
    expect(logWarn).toHaveBeenCalledTimes(1);
    const message = logWarn.mock.calls[0]?.[0] as string;
    // コメント側の失敗と取り違えないこと。分母は「状態を引こうとした件数」。
    expect(message).toContain('PR status');
    expect(message).toContain('1 of 1 failed');
    expect(message).toContain('gh not authenticated');
  });

  it('emits one line per category no matter how many tickets fail', async () => {
    /*
     * 集約はこの PR の設計そのもの。getPrBadges は commentCount>0 のチケットを
     * 全部 (実測で 300 件超) 掃くので、失敗1件ごとにログを出す実装へ戻ると
     * bd が落ちている間ずっと1リクエストあたり数百行を吐く。既存の失敗テストは
     * どちらも「1カテゴリにつき失敗1件」なので、脱集約への変異を生かしてしまう
     * (fable のレビュー指摘)。ここだけが集約を固定している。
     */
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'bdboard-bad1', projectId: a.id, commentCount: 1 }),
        makeTicket({ id: 'bdboard-bad2', projectId: a.id, commentCount: 1 }),
        makeTicket({ id: 'bdboard-bad3', projectId: a.id, commentCount: 1 }),
        makeTicket({ id: 'bdboard-pr1', projectId: a.id, commentCount: 1 }),
        makeTicket({ id: 'bdboard-pr2', projectId: a.id, commentCount: 1 }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_rootPath: string, issueId: string) => {
        if (issueId.startsWith('bdboard-bad')) {
          throw new BdError('unknown', issueId, 'bd failed');
        }
        return [
          {
            id: 'c1',
            issueId,
            author: 'agent',
            text: `PR: ${PR_URL}`,
            createdAt: new Date('2026-06-01T12:00:00.000Z'),
          },
        ];
      }),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => {
        throw new Error('gh not authenticated');
      }),
    };

    const logWarn = vi.fn();
    await getPrBadges(cache, commentReader, prStatusReader, { logWarn });

    // 失敗は 3 + 2 = 5 件あるが、行は「コメント」「PR状態」の2本だけ。
    expect(logWarn).toHaveBeenCalledTimes(2);
    const messages = logWarn.mock.calls.map((call) => call[0] as string);
    const commentLine = messages.find((line) => line.includes('could not load comments'));
    const statusLine = messages.find((line) => line.includes('could not load PR status'));
    // 分母はカテゴリごとに違う。コメントは掃いた5件、状態は引きにいった2件。
    expect(commentLine).toContain('3 of 5 failed');
    expect(statusLine).toContain('2 of 2 failed');
  });

  it('says nothing when every ticket loads', async () => {
    // 常にログを出す実装だと、正常時のログが騒音になって異常時に気づけない。
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: a.id, commentCount: 1 })],
      fingerprint: 'fp-a',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => [
        {
          id: 'c1',
          issueId: 'bdboard-a',
          author: 'agent',
          text: `PR: ${PR_URL}`,
          createdAt: new Date('2026-06-01T12:00:00.000Z'),
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'other' }) as const),
    };

    const logWarn = vi.fn();
    await getPrBadges(cache, commentReader, prStatusReader, { logWarn });

    expect(logWarn).not.toHaveBeenCalled();
  });

  it('returns url-only badge when pr status lookup returns null', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-pr',
          projectId: a.id,
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => [
        {
          id: 'c1',
          issueId: 'bdboard-pr',
          author: 'agent',
          text: `PR: ${PR_URL}`,
          createdAt: new Date('2026-06-01T12:00:00.000Z'),
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'other' }) as const),
    };

    const badges = await getPrBadges(cache, commentReader, prStatusReader);

    expect(badges).toEqual([
      {
        ticketId: 'bdboard-pr',
        projectId: 'proj-a',
        url: PR_URL,
        status: null,
      },
    ]);
  });

  it('omits tickets without a PR comment', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-chat',
          projectId: a.id,
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => [
        {
          id: 'c1',
          issueId: 'bdboard-chat',
          author: 'agent',
          text: 'just a note',
          createdAt: new Date('2026-06-01T12:00:00.000Z'),
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'other' }) as const),
    };

    const badges = await getPrBadges(cache, commentReader, prStatusReader);

    expect(badges).toEqual([]);
    expect(prStatusReader.getPrStatus).not.toHaveBeenCalled();
  });

  it('filters by projectIds when provided', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const b = project('proj-b', '/projects/b');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-a',
          projectId: a.id,
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });
    cache.putProject({
      project: b,
      tickets: [
        makeTicket({
          id: 'bdboard-b',
          projectId: b.id,
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_rootPath, issueId) => [
        {
          id: 'c1',
          issueId,
          author: 'agent',
          text: `PR: ${PR_URL}`,
          createdAt: new Date('2026-06-01T12:00:00.000Z'),
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () =>
        ({ status: { state: 'open', checkStatus: 'pass' } satisfies PrStatus }),
      ),
    };

    const badges = await getPrBadges(cache, commentReader, prStatusReader, {
      projectIds: ['proj-b'],
    });

    expect(badges).toHaveLength(1);
    expect(badges[0]?.projectId).toBe('proj-b');
    expect(badges[0]?.ticketId).toBe('bdboard-b');
  });

  it('limits comment fetch concurrency to the configured maximum', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');

    cache.putProject({
      project: a,
      tickets: Array.from({ length: 8 }, (_, index) =>
        makeTicket({
          id: `bdboard-${index}`,
          projectId: a.id,
          commentCount: 1,
        }),
      ),
      fingerprint: 'fp-a',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    let activeCount = 0;
    const maxObserved = { value: 0 };

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => {
        activeCount += 1;
        maxObserved.value = Math.max(maxObserved.value, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 50));
        activeCount -= 1;
        return [
          {
            id: 'c1',
            issueId: 'bdboard-x',
            author: 'agent',
            text: `PR: ${PR_URL}`,
            createdAt: new Date('2026-06-01T12:00:00.000Z'),
          },
        ];
      }),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'other' }) as const),
    };

    await getPrBadges(cache, commentReader, prStatusReader);

    expect(maxObserved.value).toBeLessThanOrEqual(3);
    expect(maxObserved.value).toBeGreaterThan(1);
  });

  it('sorts badges by projectId then ticketId', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const b = project('proj-b', '/projects/b');

    cache.putProject({
      project: b,
      tickets: [
        makeTicket({
          id: 'bdboard-z',
          projectId: b.id,
          commentCount: 1,
        }),
        makeTicket({
          id: 'bdboard-a',
          projectId: b.id,
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-m',
          projectId: a.id,
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_rootPath, issueId) => [
        {
          id: 'c1',
          issueId,
          author: 'agent',
          text: `PR: ${PR_URL}`,
          createdAt: new Date('2026-06-01T12:00:00.000Z'),
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'other' }) as const),
    };

    const badges = await getPrBadges(cache, commentReader, prStatusReader);

    expect(badges.map((badge) => `${badge.projectId}:${badge.ticketId}`)).toEqual([
      'proj-a:bdboard-m',
      'proj-b:bdboard-a',
      'proj-b:bdboard-z',
    ]);
  });

  it('reuses commentCache on second call when commentCount and updatedAt are unchanged', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-pr1',
          projectId: a.id,
          commentCount: 1,
          updatedAt,
        }),
        makeTicket({
          id: 'bdboard-pr2',
          projectId: a.id,
          commentCount: 2,
          updatedAt,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_rootPath, issueId) => [
        {
          id: 'c1',
          issueId,
          author: 'agent',
          text: `PR: ${PR_URL}`,
          createdAt: new Date('2026-06-01T12:00:00.000Z'),
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () =>
        ({ status: { state: 'open', checkStatus: 'pass' } satisfies PrStatus }),
      ),
    };

    const commentCache = new PrBadgeCommentCache();
    const options = { commentCache };

    const firstBadges = await getPrBadges(cache, commentReader, prStatusReader, options);
    expect(commentReader.listComments).toHaveBeenCalledTimes(2);

    const secondBadges = await getPrBadges(cache, commentReader, prStatusReader, options);
    expect(commentReader.listComments).toHaveBeenCalledTimes(2);
    expect(secondBadges).toEqual(firstBadges);
  });

  it('refetches comments only for tickets whose commentCount or updatedAt changed', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const initialUpdatedAt = new Date('2026-06-01T12:00:00.000Z');
    const refreshedUpdatedAt = new Date('2026-06-02T12:00:00.000Z');
    const PR_URL_2 = 'https://github.com/xiaotiantakumi/bdboard/pull/100';

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-stable',
          projectId: a.id,
          commentCount: 1,
          updatedAt: initialUpdatedAt,
        }),
        makeTicket({
          id: 'bdboard-changed',
          projectId: a.id,
          commentCount: 1,
          updatedAt: initialUpdatedAt,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_rootPath, issueId) => {
        const changedTicket = cache
          .getProject('proj-a')
          ?.tickets.find((ticket) => ticket.id === 'bdboard-changed');
        const url =
          issueId === 'bdboard-changed' && changedTicket?.commentCount === 2
            ? PR_URL_2
            : PR_URL;
        return [
          {
            id: 'c1',
            issueId,
            author: 'agent',
            text: `PR: ${url}`,
            createdAt: new Date('2026-06-01T12:00:00.000Z'),
          },
        ];
      }),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () =>
        ({ status: { state: 'open', checkStatus: 'pass' } satisfies PrStatus }),
      ),
    };

    const commentCache = new PrBadgeCommentCache();
    const options = { commentCache };

    const firstBadges = await getPrBadges(cache, commentReader, prStatusReader, options);
    expect(commentReader.listComments).toHaveBeenCalledTimes(2);
    expect(firstBadges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ticketId: 'bdboard-stable', url: PR_URL }),
        expect.objectContaining({ ticketId: 'bdboard-changed', url: PR_URL }),
      ]),
    );

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-stable',
          projectId: a.id,
          commentCount: 1,
          updatedAt: initialUpdatedAt,
        }),
        makeTicket({
          id: 'bdboard-changed',
          projectId: a.id,
          commentCount: 2,
          updatedAt: refreshedUpdatedAt,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: new Date('2026-06-02T12:00:00.000Z'),
    });

    const secondBadges = await getPrBadges(cache, commentReader, prStatusReader, options);
    expect(commentReader.listComments).toHaveBeenCalledTimes(3);
    expect(secondBadges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ticketId: 'bdboard-stable', url: PR_URL }),
        expect.objectContaining({ ticketId: 'bdboard-changed', url: PR_URL_2 }),
      ]),
    );
  });

  it('does not evict cache entries for projects excluded by a projectIds filter', async () => {
    // pruning を「フィルタ後の workItems」基準にすると、projectIds で1プロジェクトに
    // 絞った呼び出しのたびに他プロジェクトのキャッシュエントリが間引かれ、
    // 複数プロジェクトを行き来する通常利用 (Web UI のプロジェクト切り替え) で
    // キャッシュがまったく定着しない (bdboard-fwse レビュー指摘)。
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const b = project('proj-b', '/projects/b');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: a.id, commentCount: 1, updatedAt })],
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: b.id, commentCount: 1, updatedAt })],
      fingerprint: 'fp-b',
      fetchedAt: updatedAt,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_rootPath, issueId) => [
        {
          id: 'c1',
          issueId,
          author: 'agent',
          text: `PR: ${PR_URL}`,
          createdAt: updatedAt,
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'other' }) as const),
    };

    const commentCache = new PrBadgeCommentCache();

    // 1回目: 全プロジェクトを取得してキャッシュを埋める。
    await getPrBadges(cache, commentReader, prStatusReader, { commentCache });
    expect(commentReader.listComments).toHaveBeenCalledTimes(2);

    // 2回目: proj-a だけにフィルタした呼び出し。proj-b の workItems は今回の
    // スコープに含まれないが、それだけで proj-b のキャッシュを間引いてはいけない。
    await getPrBadges(cache, commentReader, prStatusReader, {
      commentCache,
      projectIds: ['proj-a'],
    });
    expect(commentReader.listComments).toHaveBeenCalledTimes(2);

    // 3回目: 全プロジェクトへ戻す。proj-b のキャッシュが生き残っていれば
    // listComments は増えない。
    await getPrBadges(cache, commentReader, prStatusReader, { commentCache });
    expect(commentReader.listComments).toHaveBeenCalledTimes(2);
  });

  it('reuses statusCache on second call for terminal merged/closed PRs', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-pr', projectId: a.id, commentCount: 1, updatedAt })],
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => [
        {
          id: 'c1',
          issueId: 'bdboard-pr',
          author: 'agent',
          text: `PR: ${PR_URL}`,
          createdAt: updatedAt,
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () =>
        ({ status: { state: 'merged', checkStatus: 'pass' } satisfies PrStatus }),
      ),
    };

    let fakeNow = 1_000;
    const commentCache = new PrBadgeCommentCache();
    const statusCache = new PrBadgeStatusCache({ now: () => fakeNow });
    const options = { commentCache, statusCache };

    await getPrBadges(cache, commentReader, prStatusReader, options);
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);

    fakeNow += 999_999_999;
    await getPrBadges(cache, commentReader, prStatusReader, options);
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);
  });

  it('reuses statusCache within TTL for open PRs and refetches after expiry', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-pr', projectId: a.id, commentCount: 1, updatedAt })],
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => [
        {
          id: 'c1',
          issueId: 'bdboard-pr',
          author: 'agent',
          text: `PR: ${PR_URL}`,
          createdAt: updatedAt,
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () =>
        ({ status: { state: 'open', checkStatus: 'pass' } satisfies PrStatus }),
      ),
    };

    let fakeNow = 1_000;
    const commentCache = new PrBadgeCommentCache();
    const statusCache = new PrBadgeStatusCache({ now: () => fakeNow, ttlMs: 60_000 });
    const options = { commentCache, statusCache };

    await getPrBadges(cache, commentReader, prStatusReader, options);
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);

    fakeNow += 30_000;
    await getPrBadges(cache, commentReader, prStatusReader, options);
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);

    fakeNow += 31_000;
    await getPrBadges(cache, commentReader, prStatusReader, options);
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(2);
  });

  it('does not cache PR status when getPrStatus throws', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');

    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-pr', projectId: a.id, commentCount: 1 })],
      fingerprint: 'fp-a',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => [
        {
          id: 'c1',
          issueId: 'bdboard-pr',
          author: 'agent',
          text: `PR: ${PR_URL}`,
          createdAt: new Date('2026-06-01T12:00:00.000Z'),
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi
        .fn()
        .mockRejectedValueOnce(new Error('gh not authenticated'))
        .mockResolvedValueOnce(({ status: { state: 'open', checkStatus: 'pass' } satisfies PrStatus })),
    };

    const commentCache = new PrBadgeCommentCache();
    const statusCache = new PrBadgeStatusCache();
    const logWarn = vi.fn();
    const options = { commentCache, statusCache, logWarn };

    await getPrBadges(cache, commentReader, prStatusReader, options);
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);

    await getPrBadges(cache, commentReader, prStatusReader, options);
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(2);
  });

  it('treats merged PRs with pending checks as non-terminal and respects TTL', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-pr', projectId: a.id, commentCount: 1, updatedAt })],
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => [
        {
          id: 'c1',
          issueId: 'bdboard-pr',
          author: 'agent',
          text: `PR: ${PR_URL}`,
          createdAt: updatedAt,
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () =>
        ({ status: { state: 'merged', checkStatus: 'pending' } satisfies PrStatus }),
      ),
    };

    let fakeNow = 1_000;
    const commentCache = new PrBadgeCommentCache();
    const statusCache = new PrBadgeStatusCache({ now: () => fakeNow, ttlMs: 60_000 });
    const options = { commentCache, statusCache };

    await getPrBadges(cache, commentReader, prStatusReader, options);
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);

    fakeNow += 999_999_999;
    await getPrBadges(cache, commentReader, prStatusReader, options);
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(2);
  });

  describe('close-evidence derivation from the PR-badge comment scan (bdboard-pkr6.16, M2)', () => {
    it('derives hasCloseEvidence=true when any comment matches the PR/検証 marker', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/projects/a');
      const ticket = makeTicket({
        id: 'bdboard-mixed-comments',
        projectId: a.id,
        commentCount: 2,
      });
      cache.putProject({
        project: a,
        tickets: [ticket],
        fingerprint: 'fp-a',
        fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
      });

      const commentReader: CommentReader = {
        listComments: vi.fn(async () => [
          {
            id: 'c1',
            issueId: 'bdboard-mixed-comments',
            author: 'agent',
            text: 'まだレビュー中です',
            createdAt: new Date('2026-06-01T12:00:00.000Z'),
          },
          {
            id: 'c2',
            issueId: 'bdboard-mixed-comments',
            author: 'agent',
            text: `PR: ${PR_URL}`,
            createdAt: new Date('2026-06-01T12:00:01.000Z'),
          },
        ]),
      };
      const prStatusReader: PrStatusReader = { getPrStatus: vi.fn(async () => ({ status: null, reason: 'other' }) as const) };
      const commentCache = new PrBadgeCommentCache();

      await getPrBadges(cache, commentReader, prStatusReader, { commentCache });

      expect(
        commentCache.getCloseEvidence(ticket.id, ticket.commentCount, ticket.updatedAt.getTime()),
      ).toBe(true);
    });

    it('derives hasCloseEvidence=false when no comment matches the marker', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/projects/a');
      const ticket = makeTicket({
        id: 'bdboard-no-marker-comments',
        projectId: a.id,
        commentCount: 1,
      });
      cache.putProject({
        project: a,
        tickets: [ticket],
        fingerprint: 'fp-a',
        fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
      });

      const commentReader: CommentReader = {
        listComments: vi.fn(async () => [
          {
            id: 'c1',
            issueId: 'bdboard-no-marker-comments',
            author: 'agent',
            text: 'まだレビュー中です',
            createdAt: new Date('2026-06-01T12:00:00.000Z'),
          },
        ]),
      };
      const prStatusReader: PrStatusReader = { getPrStatus: vi.fn(async () => ({ status: null, reason: 'other' }) as const) };
      const commentCache = new PrBadgeCommentCache();

      await getPrBadges(cache, commentReader, prStatusReader, { commentCache });

      expect(
        commentCache.getCloseEvidence(ticket.id, ticket.commentCount, ticket.updatedAt.getTime()),
      ).toBe(false);
    });
  });
});

describe('getPrBadges: gh rate-limit circuit breaker (bdboard-7ln6)', () => {
  it('trips the breaker on the first rate-limit and skips gh entirely for the rest while open', async () => {
    // 6 チケット・6 個の別々の PR URL。同時実行数 (COMMENT_FETCH_CONCURRENCY=3) を
    // 超える件数を用意し、「1バッチ目の rate-limit 検知後、2バッチ目は gh を
    // 1回も起動しない」ことを検証する (bdboard-7ln6 #2)。
    const { cache, urls } = makeManyProjectTickets(6);
    const tickets = cache.listProjects()[0]!.tickets;
    const commentReader = commentReaderForUrls(tickets, urls);

    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'rate-limit' }) as const),
    };

    let fakeNow = 0;
    const logWarn = vi.fn();
    const statusCache = new PrBadgeStatusCache({
      now: () => fakeNow,
      circuitInitialCooldownMs: 15 * 60_000,
      // サーキットブレーカーの警告は PrBadgeStatusCache 自身が出す (getPrBadges の
      // logWarn オプションとは別経路)。両方に同じ関数を注入して1本で検証する。
      logWarn,
    });

    const badges = await getPrBadges(cache, commentReader, prStatusReader, {
      statusCache,
      logWarn,
    });

    // 有界であること: 6件中、実際に gh が起動されたのは concurrency 上限 (3) 以下。
    // ブレーカーが開いた後は残りが1回も起動されない。
    const callCount = (prStatusReader.getPrStatus as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCount).toBeGreaterThan(0);
    expect(callCount).toBeLessThanOrEqual(3);
    expect(badges).toHaveLength(6);
    expect(badges.every((badge) => badge.status === null)).toBe(true);
    expect(statusCache.isCircuitOpen()).toBe(true);
    expect(
      logWarn.mock.calls.some((call) =>
        (call[0] as string).includes('rate limit'),
      ),
    ).toBe(true);
  });

  it('calls gh zero times on a fresh request while the breaker is open', async () => {
    const { cache, urls } = makeManyProjectTickets(1);
    const tickets = cache.listProjects()[0]!.tickets;
    const commentReader = commentReaderForUrls(tickets, urls);

    let fakeNow = 0;
    const statusCache = new PrBadgeStatusCache({
      now: () => fakeNow,
      circuitInitialCooldownMs: 15 * 60_000,
    });

    // 1回目: rate-limit を踏んでブレーカーを開く。
    const rateLimitedReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'rate-limit' }) as const),
    };
    await getPrBadges(cache, commentReader, rateLimitedReader, { statusCache });
    expect(statusCache.isCircuitOpen()).toBe(true);

    // 2回目 (同じ now、クールダウン中): 別の reader を渡し、1回も呼ばれないことを
    // 直接確認する (呼ばれていたら成功レスポンスを返してしまうダミー)。
    fakeNow += 1_000;
    const neverCalledReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: { state: 'open', checkStatus: 'pass' } }) as const),
    };
    const badges = await getPrBadges(cache, commentReader, neverCalledReader, { statusCache });

    expect(neverCalledReader.getPrStatus).not.toHaveBeenCalled();
    expect(badges[0]?.status).toBeNull();
  });

  it('recovers after the cooldown elapses and closes the breaker on the next success', async () => {
    const { cache, urls } = makeManyProjectTickets(1);
    const tickets = cache.listProjects()[0]!.tickets;
    const commentReader = commentReaderForUrls(tickets, urls);

    let fakeNow = 0;
    const statusCache = new PrBadgeStatusCache({
      now: () => fakeNow,
      circuitInitialCooldownMs: 1_000,
    });

    const rateLimitedReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'rate-limit' }) as const),
    };
    await getPrBadges(cache, commentReader, rateLimitedReader, { statusCache });
    expect(statusCache.isCircuitOpen()).toBe(true);

    // クールダウン経過前: まだ open。
    fakeNow += 500;
    expect(statusCache.isCircuitOpen()).toBe(true);

    // ちょうど境界 (now === circuitOpenUntil): 開いた瞬間からクールダウン ms
    // 経過した時点はもう open ではない (< の境界を厳密に固定する)。
    fakeNow += 500;
    expect(statusCache.isCircuitOpen()).toBe(false);

    // クールダウン経過後: half-open で次の1回は通す。
    fakeNow += 100;
    expect(statusCache.isCircuitOpen()).toBe(false);

    const healthyReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: { state: 'open', checkStatus: 'pass' } }) as const),
    };
    const badges = await getPrBadges(cache, commentReader, healthyReader, { statusCache });

    expect(healthyReader.getPrStatus).toHaveBeenCalledTimes(1);
    expect(badges[0]?.status).toEqual({ state: 'open', checkStatus: 'pass' });
    expect(statusCache.isCircuitOpen()).toBe(false);
  });

  it('doubles the cooldown on a repeat rate-limit without an intervening success', async () => {
    const { cache, urls } = makeManyProjectTickets(1);
    const tickets = cache.listProjects()[0]!.tickets;
    const commentReader = commentReaderForUrls(tickets, urls);

    let fakeNow = 0;
    const statusCache = new PrBadgeStatusCache({
      now: () => fakeNow,
      circuitInitialCooldownMs: 1_000,
      circuitMaxCooldownMs: 60_000,
    });
    const rateLimitedReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'rate-limit' }) as const),
    };

    // 1回目のトリップ: 1000ms のクールダウン。
    await getPrBadges(cache, commentReader, rateLimitedReader, { statusCache });
    fakeNow += 1_001; // クールダウン明け
    expect(statusCache.isCircuitOpen()).toBe(false);

    // half-open の probe も rate-limit → 2回目のトリップは倍の 2000ms になるはず。
    await getPrBadges(cache, commentReader, rateLimitedReader, { statusCache });
    fakeNow += 1_500; // 1000ms 明けのタイミングではまだ閉じない (倍化されていれば)
    expect(statusCache.isCircuitOpen()).toBe(true);

    fakeNow += 600; // 合計 2100ms 経過 → 2000ms のクールダウンは明けている
    expect(statusCache.isCircuitOpen()).toBe(false);
  });
});

describe('getPrBadges: per-request new-fetch budget (bdboard-7ln6 #6)', () => {
  it('caps new gh launches per call and drains the rest across subsequent calls', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');
    const urls = Array.from(
      { length: 5 },
      (_, index) => `https://github.com/xiaotiantakumi/bdboard/pull/${800 + index}`,
    );
    cache.putProject({
      project: a,
      tickets: Array.from({ length: 5 }, (_, index) =>
        makeTicket({ id: `bdboard-budget-${index}`, projectId: a.id, commentCount: 1, updatedAt }),
      ),
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });
    const tickets = cache.listProjects()[0]!.tickets;
    const commentReader = commentReaderForUrls(tickets, urls);

    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: { state: 'open', checkStatus: 'pass' } }) as const),
    };

    const statusCache = new PrBadgeStatusCache();
    const logWarn = vi.fn();

    // 1回目: 上限2件だけ新規起動。5件中3件は今回 URL のみのバッジで妥協する。
    const firstBadges = await getPrBadges(cache, commentReader, prStatusReader, {
      statusCache,
      logWarn,
      maxNewFetchesPerCall: 2,
    });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(2);
    expect(firstBadges.filter((badge) => badge.status !== null)).toHaveLength(2);
    expect(firstBadges.filter((badge) => badge.status === null)).toHaveLength(3);
    expect(
      logWarn.mock.calls.some((call) => (call[0] as string).includes('deferred')),
    ).toBe(true);

    // 2回目: 前回キャッシュされた2件はヒット、新規予算(2件)は前回見送った分から
    // 消費される。上限を超えて一度に起動しないこと自体がこのテストの本旨。
    const secondBadges = await getPrBadges(cache, commentReader, prStatusReader, {
      statusCache,
      maxNewFetchesPerCall: 2,
    });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(4);
    expect(secondBadges.filter((badge) => badge.status !== null)).toHaveLength(4);

    // 3回目: 残り1件を消化しきる。
    await getPrBadges(cache, commentReader, prStatusReader, {
      statusCache,
      maxNewFetchesPerCall: 2,
    });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(5);
  });
});

describe('getPrBadges: in-flight sharing for duplicate URLs (bdboard-7ln6 #6)', () => {
  it('launches gh only once when multiple tickets share the same PR URL concurrently', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');
    const sharedUrl = 'https://github.com/xiaotiantakumi/bdboard/pull/700';
    cache.putProject({
      project: a,
      tickets: Array.from({ length: 4 }, (_, index) =>
        makeTicket({ id: `bdboard-shared-${index}`, projectId: a.id, commentCount: 1, updatedAt }),
      ),
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_rootPath, issueId) => [
        {
          id: 'c1',
          issueId,
          author: 'agent',
          text: `PR: ${sharedUrl}`,
          createdAt: updatedAt,
        },
      ]),
    };

    // 実行がオーバーラップするよう、わずかに遅延させて解決する。
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(
        async () =>
          new Promise<{ status: { state: 'open'; checkStatus: 'pass' } }>((resolve) => {
            setTimeout(() => resolve({ status: { state: 'open', checkStatus: 'pass' } }), 20);
          }),
      ),
    };

    const statusCache = new PrBadgeStatusCache();
    const badges = await getPrBadges(cache, commentReader, prStatusReader, { statusCache });

    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);
    expect(badges).toHaveLength(4);
    expect(
      badges.every((badge) => badge.status !== null && badge.status.state === 'open'),
    ).toBe(true);
  });
});

describe('PrBadgeStatusCache: negative-cache backoff for non-rate-limit failures (bdboard-7ln6 #3)', () => {
  it('doubles the negative-cache TTL on each consecutive failure, capped at negativeCacheMaxMs', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');
    const url = 'https://github.com/xiaotiantakumi/bdboard/pull/600';
    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-nf', projectId: a.id, commentCount: 1, updatedAt })],
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => [
        { id: 'c1', issueId: 'bdboard-nf', author: 'agent', text: `PR: ${url}`, createdAt: updatedAt },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'not-found' }) as const),
    };

    let fakeNow = 0;
    const statusCache = new PrBadgeStatusCache({
      now: () => fakeNow,
      ttlMs: 60_000,
      negativeCacheMaxMs: 10_000_000,
    });

    // 1回目: 失敗streak=1、TTL=60_000。
    await getPrBadges(cache, commentReader, prStatusReader, { statusCache });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);

    // TTL 内 (59_999ms 後): キャッシュヒットで再取得しない。
    fakeNow = 59_999;
    await getPrBadges(cache, commentReader, prStatusReader, { statusCache });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);

    // TTL 超過 (60_001ms 後): 再取得。streak=2、TTL=120_000 に倍化。
    fakeNow = 60_001;
    await getPrBadges(cache, commentReader, prStatusReader, { statusCache });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(2);

    // 120_000ms 未満ならまだキャッシュヒット (60秒固定なら再取得されてしまうはず)。
    fakeNow = 60_001 + 119_999;
    await getPrBadges(cache, commentReader, prStatusReader, { statusCache });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(2);

    // 120_000ms 超過で再取得。streak=3。
    fakeNow = 60_001 + 120_001;
    await getPrBadges(cache, commentReader, prStatusReader, { statusCache });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(3);
  });
});

describe('PrBadgeStatusCache: merged/closed+pending eventual permanence (bdboard-7ln6 #4)', () => {
  it('refetches merged+pending up to mergedPendingMaxRetries, then freezes permanently', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');
    const url = 'https://github.com/xiaotiantakumi/bdboard/pull/500';
    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-mp', projectId: a.id, commentCount: 1, updatedAt })],
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });
    const commentReader: CommentReader = {
      listComments: vi.fn(async () => [
        { id: 'c1', issueId: 'bdboard-mp', author: 'agent', text: `PR: ${url}`, createdAt: updatedAt },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(
        async () => ({ status: { state: 'merged', checkStatus: 'pending' } }) as const,
      ),
    };

    let fakeNow = 0;
    const statusCache = new PrBadgeStatusCache({
      now: () => fakeNow,
      mergedPendingTtlMs: 1_000,
      mergedPendingMaxRetries: 2,
    });

    // 1回目: retries=1 (< 2), 恒久化しない。
    await getPrBadges(cache, commentReader, prStatusReader, { statusCache });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);

    // TTL 超過で2回目: retries=2 (>= 2) → 恒久化。
    fakeNow = 1_001;
    await getPrBadges(cache, commentReader, prStatusReader, { statusCache });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(2);

    // どれだけ時間が経っても (恒久キャッシュなので) 再取得されない。
    fakeNow += 999_999_999;
    const finalBadges = await getPrBadges(cache, commentReader, prStatusReader, { statusCache });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(2);
    expect(finalBadges[0]?.status).toEqual({ state: 'merged', checkStatus: 'pending' });
  });
});

describe('PrBadgeCommentCache.prune', () => {
  it('removes entries for ticket ids not in validTicketIds and keeps valid ones', () => {
    const cache = new PrBadgeCommentCache();
    const updatedAt = new Date('2026-06-01T12:00:00.000Z').getTime();
    const validId = 'bdboard-valid';
    const staleId = 'bdboard-stale';
    const staleUrl = 'https://github.com/xiaotiantakumi/bdboard/pull/100';

    cache.set(validId, 1, updatedAt, PR_URL, false);
    cache.set(staleId, 2, updatedAt, staleUrl, true);

    cache.prune(new Set([validId]));

    expect(cache.get(validId, 1, updatedAt)).toBe(PR_URL);
    expect(cache.get(staleId, 2, updatedAt)).toBeUndefined();
  });
});
