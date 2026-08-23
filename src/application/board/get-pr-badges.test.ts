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
import { getPrBadges } from './get-pr-badges.js';

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
        ({ state: 'open', checkStatus: 'pass' }) satisfies PrStatus,
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
      getPrStatus: vi.fn(async () => null),
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
        ({ state: 'merged', checkStatus: 'pass' }) satisfies PrStatus,
      ),
    };

    const badges = await getPrBadges(cache, commentReader, prStatusReader);

    expect(badges).toEqual([
      {
        ticketId: 'bdboard-ok',
        projectId: 'proj-b',
        url: PR_URL,
        status: { state: 'merged', checkStatus: 'pass' },
      },
    ]);
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
      getPrStatus: vi.fn(async () => null),
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
      getPrStatus: vi.fn(async () => null),
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
        ({ state: 'open', checkStatus: 'pass' }) satisfies PrStatus,
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
      getPrStatus: vi.fn(async () => null),
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
      getPrStatus: vi.fn(async () => null),
    };

    const badges = await getPrBadges(cache, commentReader, prStatusReader);

    expect(badges.map((badge) => `${badge.projectId}:${badge.ticketId}`)).toEqual([
      'proj-a:bdboard-m',
      'proj-b:bdboard-a',
      'proj-b:bdboard-z',
    ]);
  });
});
