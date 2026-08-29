import { describe, expect, it, vi } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import { pendingDecisionKey } from '../../domain/hygiene.js';
import type { IssueComment } from '../../domain/issue-comment.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { TicketId } from '../../domain/ticket-id.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import {
  createEmptyCfdCacheMethods,
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
} from '../ports/board-cache-fakes.js';
import type { CommentReader } from '../ports/comment-reader.js';
import { getPendingCommentAnchors } from './get-pending-comment-anchors.js';

function project(id: string, rootPath: string): Project {
  return { id, name: id, rootPath, prefixes: ['bdboard'], aliasPaths: [] };
}

function createFakeBoardCache(): BoardCache {
  const entries = new Map<string, CachedProject>();
  return {
    getProject: (id: string) => entries.get(id),
    putProject: (entry: CachedProject) => {
      entries.set(entry.project.id, entry);
    },
    listProjects: () =>
      [...entries.values()].sort((a, b) =>
        compareStrings(a.project.rootPath, b.project.rootPath),
      ),
    deleteProject: (id: string) => {
      entries.delete(id);
    },
    clear: () => entries.clear(),
    getTranscriptOffset: () => undefined,
    setTranscriptOffset: () => {},
    addSessionUsage: () => {},
    getSessionUsage: () => [],
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...createEmptyInteractionsCacheMethods(),
    close: () => {},
  };
}

function comment(issueId: TicketId, createdAt: string): IssueComment {
  return {
    id: `${issueId}-${createdAt}`,
    issueId,
    author: 'someone',
    text: 'text',
    createdAt: new Date(createdAt),
  };
}

function readerReturning(
  byId: Readonly<Record<string, readonly IssueComment[]>>,
): CommentReader & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listComments: vi.fn(async (_root: string, issueId: TicketId) => {
      calls.push(issueId);
      return byId[issueId] ?? [];
    }),
  };
}

describe('getPendingCommentAnchors', () => {
  it('returns the latest comment time keyed by project and ticket', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [makeTicket({ id: 'bdboard-wait', projectId: p.id, commentCount: 3 })],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T00:00:00.000Z'),
      pendingDecisions: [{ id: 'bdboard-wait', allowFreeform: true }],
    });

    const reader = readerReturning({
      'bdboard-wait': [
        comment('bdboard-wait', '2026-05-20T00:00:00.000Z'),
        // 最新が最後に来るとは限らない。並び順に依存しない実装であることの確認。
        comment('bdboard-wait', '2026-05-31T09:00:00.000Z'),
        comment('bdboard-wait', '2026-05-25T00:00:00.000Z'),
      ],
    });

    const anchors = await getPendingCommentAnchors(cache, reader);

    expect(anchors.get(pendingDecisionKey('/a', 'bdboard-wait'))).toEqual(
      new Date('2026-05-31T09:00:00.000Z'),
    );
    expect(anchors.size).toBe(1);
  });

  it('only fetches tickets that are actually awaiting a human', async () => {
    // ここが設計の要。最終コメント日時は bd comments <id> を1件ずつ叩くしか無いので、
    // 台帳の全チケットに広げると refresh のたびに全件ぶんのプロセス起動になる。
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [
        makeTicket({ id: 'bdboard-wait', projectId: p.id, commentCount: 1 }),
        makeTicket({ id: 'bdboard-other', projectId: p.id, commentCount: 9 }),
      ],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T00:00:00.000Z'),
      pendingDecisions: [{ id: 'bdboard-wait', allowFreeform: true }],
    });

    const reader = readerReturning({
      'bdboard-wait': [comment('bdboard-wait', '2026-05-31T00:00:00.000Z')],
      'bdboard-other': [comment('bdboard-other', '2026-05-31T00:00:00.000Z')],
    });

    await getPendingCommentAnchors(cache, reader);

    expect(reader.calls).toEqual(['bdboard-wait']);
  });

  it('skips pending tickets that have no comments at all', async () => {
    // commentCount で足切りしないと、コメント0件のチケットにも bd を1回叩く。
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [makeTicket({ id: 'bdboard-wait', projectId: p.id, commentCount: 0 })],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T00:00:00.000Z'),
      pendingDecisions: [{ id: 'bdboard-wait', allowFreeform: true }],
    });

    const reader = readerReturning({});
    const anchors = await getPendingCommentAnchors(cache, reader);

    expect(reader.calls).toEqual([]);
    expect(anchors.size).toBe(0);
  });

  it('does nothing for a project with no pending decisions', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [makeTicket({ id: 'bdboard-x', projectId: p.id, commentCount: 4 })],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    const reader = readerReturning({});
    expect((await getPendingCommentAnchors(cache, reader)).size).toBe(0);
    expect(reader.calls).toEqual([]);
  });

  it('honours the projectIds filter', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    for (const p of [a, b]) {
      cache.putProject({
        project: p,
        tickets: [makeTicket({ id: 'bdboard-wait', projectId: p.id, commentCount: 1 })],
        fingerprint: `fp-${p.id}`,
        fetchedAt: new Date('2026-06-01T00:00:00.000Z'),
        pendingDecisions: [{ id: 'bdboard-wait', allowFreeform: true }],
      });
    }

    const reader = readerReturning({
      'bdboard-wait': [comment('bdboard-wait', '2026-05-31T00:00:00.000Z')],
    });

    const anchors = await getPendingCommentAnchors(cache, reader, { projectIds: ['/b'] });

    // 同じIDが両プロジェクトに居るので、キーが projectId 込みでないと取り違える。
    expect([...anchors.keys()]).toEqual([pendingDecisionKey('/b', 'bdboard-wait')]);
    expect(reader.calls).toEqual(['bdboard-wait']);
  });

  it('keeps going when one ticket fails to load', async () => {
    // 1件の失敗で健全性パネル全体を落とさない。取れなかったぶんは updatedAt だけを
    // 見る従来の判定に落ちる (誤検知が1件増えるだけ)。
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [
        makeTicket({ id: 'bdboard-bad', projectId: p.id, commentCount: 1 }),
        makeTicket({ id: 'bdboard-good', projectId: p.id, commentCount: 1 }),
      ],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T00:00:00.000Z'),
      pendingDecisions: [
        { id: 'bdboard-bad', allowFreeform: true },
        { id: 'bdboard-good', allowFreeform: true },
      ],
    });

    const reader: CommentReader = {
      listComments: async (_root, issueId) => {
        if (issueId === 'bdboard-bad') {
          throw new Error('bd exploded');
        }
        return [comment('bdboard-good', '2026-05-31T00:00:00.000Z')];
      },
    };

    const anchors = await getPendingCommentAnchors(cache, reader);

    expect([...anchors.keys()]).toEqual([pendingDecisionKey('/a', 'bdboard-good')]);
  });

  it('ignores comments whose timestamp is unusable', async () => {
    // 壊れた日付を最大値として拾うと NaN がアンカーになり、比較が全部 false になって
    // 静かに検知が消える。
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [makeTicket({ id: 'bdboard-wait', projectId: p.id, commentCount: 2 })],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T00:00:00.000Z'),
      pendingDecisions: [{ id: 'bdboard-wait', allowFreeform: true }],
    });

    const reader = readerReturning({
      'bdboard-wait': [
        comment('bdboard-wait', 'not a date'),
        comment('bdboard-wait', '2026-05-30T00:00:00.000Z'),
      ],
    });

    const anchors = await getPendingCommentAnchors(cache, reader);

    expect(anchors.get(pendingDecisionKey('/a', 'bdboard-wait'))).toEqual(
      new Date('2026-05-30T00:00:00.000Z'),
    );
  });

  it('leaves the ticket out entirely when every comment is unusable', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [makeTicket({ id: 'bdboard-wait', projectId: p.id, commentCount: 1 })],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T00:00:00.000Z'),
      pendingDecisions: [{ id: 'bdboard-wait', allowFreeform: true }],
    });

    const reader = readerReturning({
      'bdboard-wait': [comment('bdboard-wait', 'not a date')],
    });

    expect((await getPendingCommentAnchors(cache, reader)).size).toBe(0);
  });
});
