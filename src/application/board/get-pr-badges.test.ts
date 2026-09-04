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
      getPrStatus: vi.fn(async () => null),
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
        ({ state: 'open', checkStatus: 'pass' }) satisfies PrStatus,
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
        ({ state: 'open', checkStatus: 'pass' }) satisfies PrStatus,
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
      getPrStatus: vi.fn(async () => null),
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
        ({ state: 'merged', checkStatus: 'pass' }) satisfies PrStatus,
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
        ({ state: 'open', checkStatus: 'pass' }) satisfies PrStatus,
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
        .mockResolvedValueOnce(({ state: 'open', checkStatus: 'pass' }) satisfies PrStatus),
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
        ({ state: 'merged', checkStatus: 'pending' }) satisfies PrStatus,
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
      const prStatusReader: PrStatusReader = { getPrStatus: vi.fn(async () => null) };
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
      const prStatusReader: PrStatusReader = { getPrStatus: vi.fn(async () => null) };
      const commentCache = new PrBadgeCommentCache();

      await getPrBadges(cache, commentReader, prStatusReader, { commentCache });

      expect(
        commentCache.getCloseEvidence(ticket.id, ticket.commentCount, ticket.updatedAt.getTime()),
      ).toBe(false);
    });
  });
});
