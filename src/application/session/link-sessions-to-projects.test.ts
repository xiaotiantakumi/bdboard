import { describe, expect, it } from 'vitest';
import type { Project } from '../../domain/project.js';
import type { AgentSession } from '../../domain/session.js';
import { groupSessionsByProject, resolveSessionProject } from './link-sessions-to-projects.js';

function project(
  id: string,
  rootPath: string,
  aliasPaths: readonly string[] = [],
): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: [],
    aliasPaths,
  };
}

function session(sessionId: string, cwd: string): AgentSession {
  return {
    sessionId,
    pid: 1,
    cwd,
    startedAt: new Date(0),
    lastActivityAt: new Date(0),
    alive: true,
  };
}

describe('resolveSessionProject', () => {
  const projects = [
    project('a', '/a'),
    project('ab', '/a/b'),
    project('bc', '/a/bc'),
  ];

  it('matches cwd equal to rootPath', () => {
    expect(resolveSessionProject('/a/b', projects)?.id).toBe('ab');
  });

  it('matches cwd under rootPath', () => {
    expect(resolveSessionProject('/a/b/src', projects)?.id).toBe('ab');
  });

  it('matches worktree paths under project root', () => {
    expect(
      resolveSessionProject('/a/b/.claude/worktrees/epic-x', projects)?.id,
    ).toBe('ab');
  });

  it('does not match sibling paths with shared prefix', () => {
    const onlyAb = [project('ab', '/a/b')];
    expect(resolveSessionProject('/a/bc', onlyAb)).toBeUndefined();

    const withBc = [project('ab', '/a/b'), project('bc', '/a/bc')];
    expect(resolveSessionProject('/a/bc', withBc)?.id).toBe('bc');
    expect(resolveSessionProject('/a/bc/foo', withBc)?.id).toBe('bc');
  });

  it('returns undefined when no project matches', () => {
    expect(resolveSessionProject('/z/other', projects)).toBeUndefined();
  });

  it('chooses the longest matching rootPath', () => {
    const nested = [project('root', '/a'), project('child', '/a/b')];
    expect(resolveSessionProject('/a/b/x', nested)?.id).toBe('child');
  });

  it('normalizes trailing slash on rootPath', () => {
    const withSlash = [project('slash', '/a/b/')];
    expect(resolveSessionProject('/a/b/src', withSlash)?.id).toBe('slash');
  });

  it('resolves cwd under an alias path to the parent project', () => {
    const projects = [project('main', '/r/main', ['/w/foo'])];
    expect(resolveSessionProject('/w/foo/sub', projects)?.id).toBe('main');
  });

  it('does not match alias paths without a path separator boundary', () => {
    const projects = [project('main', '/r/main', ['/w/foo'])];
    expect(resolveSessionProject('/w/foo2', projects)).toBeUndefined();
  });

  it('still resolves in-tree worktree paths under the project root', () => {
    const projects = [project('main', '/r/main')];
    expect(
      resolveSessionProject('/r/main/.claude/worktrees/epic-x', projects)?.id,
    ).toBe('main');
  });

  it('prefers the project with the longest matched path when alias is longer than another root', () => {
    const projects = [
      project('short', '/a'),
      project('alias-long', '/z/other', ['/a/b/c/d']),
    ];
    expect(resolveSessionProject('/a/b/c/d/work', projects)?.id).toBe('alias-long');
  });
});

describe('groupSessionsByProject', () => {
  const projects = [project('p1', '/a/b'), project('p2', '/x/y')];
  const sessions = [
    session('s-2', '/a/b/work'),
    session('s-1', '/x/y'),
    session('s-orphan', '/nowhere'),
  ];

  it('groups by project id with sessionId ascending order', () => {
    const grouped = groupSessionsByProject(sessions, projects);

    expect([...grouped.keys()].sort()).toEqual(['p1', 'p2']);
    expect(grouped.get('p1')?.map((s) => s.sessionId)).toEqual(['s-2']);
    expect(grouped.get('p2')?.map((s) => s.sessionId)).toEqual(['s-1']);
    expect(grouped.has('orphan')).toBe(false);
  });

  it('sorts multiple sessions per project by sessionId', () => {
    const grouped = groupSessionsByProject(
      [session('z-2', '/a/b'), session('a-1', '/a/b'), session('m-3', '/a/b')],
      [project('p1', '/a/b')],
    );

    expect(grouped.get('p1')?.map((s) => s.sessionId)).toEqual(['a-1', 'm-3', 'z-2']);
  });

  it('omits projects with no matching sessions', () => {
    const grouped = groupSessionsByProject([session('only', '/a/b')], projects);
    expect([...grouped.keys()]).toEqual(['p1']);
  });

  it('groups sessions under alias paths by the parent project id', () => {
    const projects = [project('main', '/r/main', ['/w/foo'])];
    const grouped = groupSessionsByProject(
      [session('alias-sess', '/w/foo/sub')],
      projects,
    );

    expect([...grouped.keys()]).toEqual(['main']);
    expect(grouped.get('main')?.map((s) => s.sessionId)).toEqual(['alias-sess']);
  });
});
