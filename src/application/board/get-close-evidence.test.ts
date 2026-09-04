import { describe, expect, it, vi } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import { pendingDecisionKey } from '../../domain/hygiene.js';
import type { IssueComment } from '../../domain/issue-comment.js';
import type { Project } from '../../domain/project.js';
import { DEFAULT_HYGIENE_THRESHOLDS } from '../../domain/hygiene-thresholds.js';
import { makeTicket } from '../../domain/test-support.js';
import type { TicketId } from '../../domain/ticket-id.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import {
  createEmptyCfdCacheMethods,
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
} from '../ports/board-cache-fakes.js';
import type { CommentReader } from '../ports/comment-reader.js';
import { getCloseEvidenceKeys } from './get-close-evidence.js';

const WINDOW_MS = DEFAULT_HYGIENE_THRESHOLDS.closedWithoutEvidenceWindowMs;

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

function comment(issueId: TicketId, text: string): IssueComment {
  return {
    id: `${issueId}-1`,
    issueId,
    author: 'someone',
    text,
    createdAt: new Date(0),
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

function closedTicket(
  id: TicketId,
  projectId: string,
  options: {
    readonly closedAtOffsetMs: number;
    readonly commentCount?: number;
    readonly issueType?: string;
    readonly labels?: readonly string[];
  },
) {
  const now = new Date('2026-06-01T12:00:00.000Z');
  return makeTicket({
    id,
    projectId,
    status: 'closed',
    commentCount: options.commentCount ?? 1,
    closedAt: new Date(now.getTime() - options.closedAtOffsetMs),
    issueType: options.issueType,
    labels: options.labels,
  });
}

describe('getCloseEvidenceKeys', () => {
  const now = new Date('2026-06-01T12:00:00.000Z');
  const withinWindow = WINDOW_MS - 60_000;

  it('includes a key when a comment contains PR:', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [closedTicket('bdboard-pr', p.id, { closedAtOffsetMs: withinWindow })],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({
      'bdboard-pr': [comment('bdboard-pr', 'merged via PR: https://github.com/x/y/pull/1')],
    });

    const keys = await getCloseEvidenceKeys(cache, reader, now, WINDOW_MS);

    expect([...keys]).toEqual([pendingDecisionKey('/a', 'bdboard-pr')]);
  });

  it('includes a key when a comment contains 検証:', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [closedTicket('bdboard-verify', p.id, { closedAtOffsetMs: withinWindow })],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({
      'bdboard-verify': [comment('bdboard-verify', '手元で検証: npm run verify 通過')],
    });

    const keys = await getCloseEvidenceKeys(cache, reader, now, WINDOW_MS);

    expect([...keys]).toEqual([pendingDecisionKey('/a', 'bdboard-verify')]);
  });

  it('accepts full-width colons in PR and 検証 markers', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [
        closedTicket('bdboard-full-pr', p.id, { closedAtOffsetMs: withinWindow }),
        closedTicket('bdboard-full-verify', p.id, {
          closedAtOffsetMs: withinWindow,
          commentCount: 2,
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({
      'bdboard-full-pr': [comment('bdboard-full-pr', 'PR：https://github.com/x/y/pull/2')],
      'bdboard-full-verify': [
        comment('bdboard-full-verify', '検証：TZ=UTC npm run verify 通過'),
      ],
    });

    const keys = await getCloseEvidenceKeys(cache, reader, now, WINDOW_MS);

    expect([...keys].sort()).toEqual(
      [pendingDecisionKey('/a', 'bdboard-full-pr'), pendingDecisionKey('/a', 'bdboard-full-verify')].sort(),
    );
  });

  it('omits a key when no comment contains PR or 検証 markers', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [closedTicket('bdboard-plain', p.id, { closedAtOffsetMs: withinWindow })],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({
      'bdboard-plain': [comment('bdboard-plain', 'close しました')],
    });

    const keys = await getCloseEvidenceKeys(cache, reader, now, WINDOW_MS);

    expect(keys.size).toBe(0);
  });

  it('does not fetch comments for tickets outside the close window', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [
        closedTicket('bdboard-old', p.id, { closedAtOffsetMs: WINDOW_MS + 60_000 }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({});
    const keys = await getCloseEvidenceKeys(cache, reader, now, WINDOW_MS);

    expect(reader.calls).toEqual([]);
    expect(keys.size).toBe(0);
  });

  it('does not fetch comments when commentCount is zero', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [
        closedTicket('bdboard-no-comments', p.id, {
          closedAtOffsetMs: withinWindow,
          commentCount: 0,
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({});
    const keys = await getCloseEvidenceKeys(cache, reader, now, WINDOW_MS);

    expect(reader.calls).toEqual([]);
    expect(keys.size).toBe(0);
  });

  it('does not fetch comments for epic, gate, or gt:slot tickets', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [
        closedTicket('bdboard-epic', p.id, {
          closedAtOffsetMs: withinWindow,
          issueType: 'epic',
        }),
        closedTicket('bdboard-gate', p.id, {
          closedAtOffsetMs: withinWindow,
          issueType: 'gate',
        }),
        closedTicket('bdboard-slot', p.id, {
          closedAtOffsetMs: withinWindow,
          labels: ['gt:slot'],
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({});
    const keys = await getCloseEvidenceKeys(cache, reader, now, WINDOW_MS);

    expect(reader.calls).toEqual([]);
    expect(keys.size).toBe(0);
  });

  it('keeps going when one ticket fails to load and emits a single warning line', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [
        closedTicket('bdboard-bad', p.id, { closedAtOffsetMs: withinWindow }),
        closedTicket('bdboard-good', p.id, { closedAtOffsetMs: withinWindow }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader: CommentReader = {
      listComments: async (_root, issueId) => {
        if (issueId === 'bdboard-bad') {
          throw new Error('bd exploded');
        }
        return [comment('bdboard-good', 'PR: https://github.com/x/y/pull/3')];
      },
    };

    const logWarn = vi.fn();
    const keys = await getCloseEvidenceKeys(cache, reader, now, WINDOW_MS, { logWarn });

    expect([...keys]).toEqual([pendingDecisionKey('/a', 'bdboard-good')]);
    expect(logWarn).toHaveBeenCalledTimes(1);
    const message = logWarn.mock.calls[0]?.[0] as string;
    expect(message).toContain('[close-evidence]');
    expect(message).toContain('1 of 2 failed');
    expect(message).toContain('bdboard-bad');
    expect(message).toContain('bd exploded');
  });
});
