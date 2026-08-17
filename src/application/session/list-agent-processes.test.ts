import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../ports/board-cache-fakes.js';
import type { Project } from '../../domain/project.js';
import type { ScannedProcess } from '../ports/process-scanner.js';
import { listAgentProcesses } from './list-agent-processes.js';

function project(
  id: string,
  name: string,
  rootPath: string,
): Project {
  return {
    id,
    name,
    rootPath,
    prefixes: [],
    aliasPaths: [],
  };
}

function createFakeCache(entries: readonly CachedProject[]): BoardCache {
  return {
    getProject(projectId: string): CachedProject | undefined {
      return entries.find((entry) => entry.project.id === projectId);
    },
    putProject(): void {},
    listProjects(): readonly CachedProject[] {
      return [...entries].sort((a, b) =>
        compareStrings(a.project.rootPath, b.project.rootPath),
      );
    },
    deleteProject(): void {},
    clear(): void {},
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

function cached(projectEntry: Project): CachedProject {
  return {
    project: projectEntry,
    tickets: [],
    fingerprint: `fp-${projectEntry.id}`,
    fetchedAt: new Date(0),
  };
}

function scanned(
  overrides: Partial<ScannedProcess> & Pick<ScannedProcess, 'pid' | 'command' | 'cwd'>,
): ScannedProcess {
  return {
    ...overrides,
  };
}

describe('listAgentProcesses', () => {
  const cache = createFakeCache([
    cached(project('root', 'Root Project', '/work/root')),
    cached(project('child', 'Child Project', '/work/root/child')),
    cached(project('other', 'Other Project', '/work/other')),
  ]);

  it('resolves cwd that exactly matches project rootPath', () => {
    const result = listAgentProcesses(
      [scanned({ pid: 1, command: 'claude', cwd: '/work/other' })],
      cache,
    );

    expect(result[0]).toMatchObject({
      projectId: 'other',
      projectName: 'Other Project',
    });
  });

  it('resolves cwd under project rootPath', () => {
    const result = listAgentProcesses(
      [scanned({ pid: 2, command: 'codex', cwd: '/work/root/child/src' })],
      cache,
    );

    expect(result[0]).toMatchObject({
      projectId: 'child',
      projectName: 'Child Project',
    });
  });

  it('chooses the longest matching rootPath', () => {
    const result = listAgentProcesses(
      [scanned({ pid: 3, command: 'agy', cwd: '/work/root/child/pkg' })],
      cache,
    );

    expect(result[0]).toMatchObject({
      projectId: 'child',
      projectName: 'Child Project',
    });
  });

  it('leaves project fields undefined when cwd does not match', () => {
    const result = listAgentProcesses(
      [scanned({ pid: 4, command: 'gemini', cwd: '/tmp/nowhere' })],
      cache,
    );

    expect(result[0]).toEqual({
      pid: 4,
      command: 'gemini',
      cwd: '/tmp/nowhere',
    });
  });

  it('sorts by project name ascending then pid ascending with unresolved last', () => {
    const result = listAgentProcesses(
      [
        scanned({ pid: 30, command: 'claude', cwd: '/tmp/unresolved' }),
        scanned({ pid: 20, command: 'claude', cwd: '/work/other' }),
        scanned({ pid: 10, command: 'claude', cwd: '/work/root/child' }),
        scanned({ pid: 15, command: 'codex', cwd: '/work/root' }),
      ],
      cache,
    );

    expect(result.map((entry) => entry.pid)).toEqual([10, 20, 15, 30]);
    expect(result.map((entry) => entry.projectName ?? null)).toEqual([
      'Child Project',
      'Other Project',
      'Root Project',
      null,
    ]);
  });
});
