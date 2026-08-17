import { describe, expect, it } from 'vitest';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../ports/board-cache-fakes.js';
import type { ModelUsageTotals } from '../transcript/extract-usage.js';
import { compareStrings } from '../../domain/compare.js';
import type { SessionLink } from '../../domain/session.js';
import { getTicketTokenUsage, hasTicketTokenUsage } from './get-ticket-token-usage.js';

function createFakeBoardCache(
  usageBySession: Readonly<Record<string, readonly ModelUsageTotals[]>> = {},
): BoardCache & { readonly entries: Map<string, CachedProject> } {
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
      return [...entries.values()].sort((left, right) =>
        compareStrings(left.project.rootPath, right.project.rootPath),
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
    getSessionUsage(sessionIds: readonly string[]): readonly ModelUsageTotals[] {
      const merged = new Map<string, ModelUsageTotals>();

      for (const sessionId of sessionIds) {
        const usageRows = usageBySession[sessionId] ?? [];
        for (const row of usageRows) {
          const existing = merged.get(row.model);
          if (existing === undefined) {
            merged.set(row.model, { ...row });
            continue;
          }

          merged.set(row.model, {
            model: row.model,
            inputTokens: existing.inputTokens + row.inputTokens,
            outputTokens: existing.outputTokens + row.outputTokens,
            cacheCreationInputTokens:
              existing.cacheCreationInputTokens + row.cacheCreationInputTokens,
            cacheReadInputTokens:
              existing.cacheReadInputTokens + row.cacheReadInputTokens,
          });
        }
      }

      return [...merged.values()].sort((left, right) =>
        compareStrings(left.model, right.model),
      );
    },
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...createEmptyInteractionsCacheMethods(),
    close(): void {},
  };
}

function link(
  ticketId: string,
  sessionId: string,
  observedAt: Date = new Date('2026-08-15T00:00:00.000Z'),
): SessionLink {
  return {
    ticketId,
    sessionId,
    source: 'transcript',
    confidence: 0.6,
    observedAt,
  };
}

describe('getTicketTokenUsage', () => {
  it('aggregates usage across linked sessions for a ticket', () => {
    const cache = createFakeBoardCache({
      'sess-a': [
        {
          model: 'claude-opus-5',
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 100,
          cacheReadInputTokens: 20,
        },
      ],
      'sess-b': [
        {
          model: 'claude-opus-5',
          inputTokens: 2,
          outputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 30,
        },
        {
          model: 'claude-sonnet-5',
          inputTokens: 7,
          outputTokens: 3,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      ],
    });

    const usage = getTicketTokenUsage(
      'bdboard-3tw.10',
      [
        link('bdboard-3tw.10', 'sess-a'),
        link('bdboard-3tw.10', 'sess-b'),
        link('bdboard-3tw.10', 'sess-a'),
      ],
      cache,
    );

    expect(usage).toEqual({
      ticketId: 'bdboard-3tw.10',
      totalInputTokens: 19,
      totalOutputTokens: 9,
      totalCacheCreationInputTokens: 100,
      totalCacheReadInputTokens: 50,
      byModel: [
        {
          model: 'claude-opus-5',
          inputTokens: 12,
          outputTokens: 6,
          cacheCreationInputTokens: 100,
          cacheReadInputTokens: 50,
        },
        {
          model: 'claude-sonnet-5',
          inputTokens: 7,
          outputTokens: 3,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      ],
    });
    expect(hasTicketTokenUsage(usage)).toBe(true);
  });

  it('returns zero usage when no sessions are linked', () => {
    const cache = createFakeBoardCache();
    const usage = getTicketTokenUsage('bdboard-abc', [], cache);

    expect(usage).toEqual({
      ticketId: 'bdboard-abc',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationInputTokens: 0,
      totalCacheReadInputTokens: 0,
      byModel: [],
    });
    expect(hasTicketTokenUsage(usage)).toBe(false);
  });
});
