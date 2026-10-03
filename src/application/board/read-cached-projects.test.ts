import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { CachedProject } from '../ports/board-cache.js';
import { readProjectEntries, readProjectRefs } from './read-cached-projects.js';

const FETCHED_AT = new Date('2026-10-03T00:00:00.000Z');

function project(id: string, rootPath: string): Project {
  return { id, name: id, rootPath, prefixes: ['pfx'], aliasPaths: [] };
}

function entry(proj: Project): CachedProject {
  return {
    project: proj,
    tickets: [makeTicket({ id: `pfx-${proj.id}`, projectId: proj.id })],
    fingerprint: `fp-${proj.id}`,
    fetchedAt: FETCHED_AT,
  };
}

const entries = [entry(project('a', '/a')), entry(project('b', '/b'))];

describe('readProjectEntries (bdboard-5lnh)', () => {
  it('uses listProjectsChunked() and never the synchronous listProjects() when the cache has it', async () => {
    const listProjects = vi.fn(() => entries);
    const listProjectsChunked = vi.fn(() => Promise.resolve(entries));

    const result = await readProjectEntries({ listProjects, listProjectsChunked });

    expect(result).toBe(entries);
    expect(listProjectsChunked).toHaveBeenCalledTimes(1);
    expect(listProjects).not.toHaveBeenCalled();
  });

  it('falls back to listProjects() with the same result when listProjectsChunked is absent', async () => {
    const listProjects = vi.fn(() => entries);

    const result = await readProjectEntries({ listProjects });

    expect(result).toBe(entries);
    expect(listProjects).toHaveBeenCalledTimes(1);
  });
});

describe('readProjectRefs (bdboard-5lnh)', () => {
  it('uses listProjectRefs() and never listProjects() when the cache has it', () => {
    const refs = entries.map((candidate) => candidate.project);
    const listProjects = vi.fn(() => entries);
    const listProjectRefs = vi.fn(() => refs);

    const result = readProjectRefs({ listProjects, listProjectRefs });

    expect(result).toBe(refs);
    expect(listProjectRefs).toHaveBeenCalledTimes(1);
    expect(listProjects).not.toHaveBeenCalled();
  });

  it('falls back to listProjects().map(entry => entry.project), preserving order, when listProjectRefs is absent', () => {
    const listProjects = vi.fn(() => entries);

    const result = readProjectRefs({ listProjects });

    expect(result).toEqual(entries.map((candidate) => candidate.project));
    expect(result[0]).toBe(entries[0]?.project);
    expect(result[1]).toBe(entries[1]?.project);
    expect(listProjects).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list for an empty cache on both paths', () => {
    expect(readProjectRefs({ listProjects: () => [] })).toEqual([]);
    expect(readProjectRefs({ listProjects: () => [], listProjectRefs: () => [] })).toEqual([]);
  });
});
