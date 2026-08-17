import { describe, expect, it } from 'vitest';
import {
  buildBdCommand,
  buildDependencyCycleRemovalCommands,
  buildWorktreeCleanupCommands,
  DEFER_DAYS,
  formatDeferDate,
  formatDependencyCycleRemovalScript,
  formatWorktreeCleanupScript,
  shellQuote,
} from './bdCommands';

describe('shellQuote', () => {
  it('wraps plain strings in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('quotes strings containing spaces', () => {
    expect(shellQuote('evil path')).toBe("'evil path'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('quotes shell metacharacters literally', () => {
    expect(shellQuote('; echo INJECTED')).toBe("'; echo INJECTED'");
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
  });

  it('quotes empty strings as empty single-quoted pair', () => {
    expect(shellQuote('')).toBe("''");
  });
});

describe('formatDeferDate', () => {
  it('returns a date DEFER_DAYS ahead of the given day', () => {
    expect(formatDeferDate(new Date(2026, 7, 15, 3, 0, 0))).toBe('2026-08-22');
    expect(DEFER_DAYS).toBe(7);
  });

  it('rolls over month and year boundaries', () => {
    expect(formatDeferDate(new Date(2026, 11, 28, 23, 30, 0))).toBe('2027-01-04');
  });
});

describe('buildBdCommand', () => {
  it('defers to a future date, never to today', () => {
    const command = buildBdCommand('defer', 'bdboard-abc.1', '/repo');
    const match = /--defer '(\d{4}-\d{2}-\d{2})'$/.exec(command);
    expect(match).not.toBeNull();

    const deferDate = new Date(`${match?.[1] ?? ''}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    expect(deferDate.getTime()).toBeGreaterThan(today.getTime());
  });

  it('prefixes every command with -C when the root path is known', () => {
    expect(buildBdCommand('claim', 'bdboard-abc.1', '/repo')).toBe(
      "bd -C '/repo' update 'bdboard-abc.1' --claim",
    );
    expect(buildBdCommand('close', 'bdboard-abc.1', '/repo')).toBe(
      "bd -C '/repo' close 'bdboard-abc.1'",
    );
  });

  it('shell-quotes rootPath and ticketId for safe clipboard paste', () => {
    expect(
      buildBdCommand('claim', 'qaevil-6r7', '/tmp/fixture-evil path; echo INJECTED'),
    ).toBe(
      "bd -C '/tmp/fixture-evil path; echo INJECTED' update 'qaevil-6r7' --claim",
    );
  });

  it('escapes single quotes in rootPath', () => {
    expect(buildBdCommand('claim', 'bdboard-abc.1', "/tmp/it's here")).toBe(
      "bd -C '/tmp/it'\\''s here' update 'bdboard-abc.1' --claim",
    );
  });

  it('uses bd prefix without -C when rootPath is omitted', () => {
    expect(buildBdCommand('claim', 'bdboard-abc.1')).toBe(
      "bd update 'bdboard-abc.1' --claim",
    );
  });
});

describe('buildWorktreeCleanupCommands', () => {
  it('returns worktree remove then branch -d when both are present', () => {
    const commands = buildWorktreeCleanupCommands({
      repoRootPath: '/repo',
      worktreePath: '/repo/.claude/worktrees/bdboard-3tw.96',
      branchName: 'bd/bdboard-3tw.96',
    });

    expect(commands).toEqual([
      "git -C '/repo' worktree remove '/repo/.claude/worktrees/bdboard-3tw.96'",
      "git -C '/repo' branch -d 'bd/bdboard-3tw.96'",
    ]);
  });

  it('returns only worktree remove when branchName is null', () => {
    expect(
      buildWorktreeCleanupCommands({
        repoRootPath: '/repo',
        worktreePath: '/repo/.claude/worktrees/wt',
        branchName: null,
      }),
    ).toEqual(["git -C '/repo' worktree remove '/repo/.claude/worktrees/wt'"]);
  });

  it('returns only branch -d when worktreePath is null', () => {
    expect(
      buildWorktreeCleanupCommands({
        repoRootPath: '/repo',
        worktreePath: null,
        branchName: 'bd/bdboard-3tw.96',
      }),
    ).toEqual(["git -C '/repo' branch -d 'bd/bdboard-3tw.96'"]);
  });

  it('returns an empty array when both paths are null', () => {
    expect(
      buildWorktreeCleanupCommands({
        repoRootPath: '/repo',
        worktreePath: null,
        branchName: null,
      }),
    ).toEqual([]);
  });

  it('quotes paths containing spaces as a single shell argument', () => {
    const commands = buildWorktreeCleanupCommands({
      repoRootPath: '/Users/example/my repo',
      worktreePath: '/Users/example/my repo/.claude/worktrees/bdboard-3tw.96',
      branchName: 'bd/bdboard-3tw.96',
    });

    expect(commands).toEqual([
      "git -C '/Users/example/my repo' worktree remove '/Users/example/my repo/.claude/worktrees/bdboard-3tw.96'",
      "git -C '/Users/example/my repo' branch -d 'bd/bdboard-3tw.96'",
    ]);
  });

  it('escapes embedded single quotes in paths', () => {
    const commands = buildWorktreeCleanupCommands({
      repoRootPath: "/Users/example/it's a repo",
      worktreePath: "/Users/example/it's a repo/wt",
      branchName: 'bd/bdboard-3tw.96',
    });

    expect(commands).toEqual([
      "git -C '/Users/example/it'\\''s a repo' worktree remove '/Users/example/it'\\''s a repo/wt'",
      "git -C '/Users/example/it'\\''s a repo' branch -d 'bd/bdboard-3tw.96'",
    ]);
  });

  it('keeps shell metacharacters inside quotes to prevent injection', () => {
    const commands = buildWorktreeCleanupCommands({
      repoRootPath: '/tmp/a b;rm -rf $HOME/c',
      worktreePath: '/tmp/a b;rm -rf $HOME/c/.claude/worktrees/wt',
      branchName: 'bd/bdboard-3tw.96',
    });

    expect(commands).toHaveLength(2);
    expect(commands[0]).toBe(
      "git -C '/tmp/a b;rm -rf $HOME/c' worktree remove '/tmp/a b;rm -rf $HOME/c/.claude/worktrees/wt'",
    );
    expect(commands[1]).toBe(
      "git -C '/tmp/a b;rm -rf $HOME/c' branch -d 'bd/bdboard-3tw.96'",
    );
  });
});

describe('formatWorktreeCleanupScript', () => {
  it('joins commands with newlines', () => {
    expect(
      formatWorktreeCleanupScript({
        repoRootPath: '/repo',
        worktreePath: '/repo/.claude/worktrees/wt',
        branchName: 'bd/bdboard-3tw.96',
      }),
    ).toBe(
      "git -C '/repo' worktree remove '/repo/.claude/worktrees/wt'\n" +
        "git -C '/repo' branch -d 'bd/bdboard-3tw.96'",
    );
  });

  it('returns an empty string when there are no commands', () => {
    expect(
      formatWorktreeCleanupScript({
        repoRootPath: '/repo',
        worktreePath: null,
        branchName: null,
      }),
    ).toBe('');
  });
});

describe('buildDependencyCycleRemovalCommands', () => {
  it('returns bd dep remove without -C when rootPath is omitted', () => {
    expect(
      buildDependencyCycleRemovalCommands([
        { issueId: 'bdboard-a', dependsOnId: 'bdboard-b' },
      ]),
    ).toEqual(["bd dep remove 'bdboard-a' 'bdboard-b'"]);
  });

  it('returns bd -C dep remove when rootPath is provided', () => {
    expect(
      buildDependencyCycleRemovalCommands(
        [{ issueId: 'bdboard-a', dependsOnId: 'bdboard-b' }],
        '/repo/root',
      ),
    ).toEqual(["bd -C '/repo/root' dep remove 'bdboard-a' 'bdboard-b'"]);
  });

  it('returns one command per edge', () => {
    expect(
      buildDependencyCycleRemovalCommands([
        { issueId: 'bdboard-a', dependsOnId: 'bdboard-b' },
        { issueId: 'bdboard-b', dependsOnId: 'bdboard-a' },
      ]),
    ).toEqual([
      "bd dep remove 'bdboard-a' 'bdboard-b'",
      "bd dep remove 'bdboard-b' 'bdboard-a'",
    ]);
  });
});

describe('formatDependencyCycleRemovalScript', () => {
  it('joins commands with newlines', () => {
    expect(
      formatDependencyCycleRemovalScript([
        { issueId: 'bdboard-a', dependsOnId: 'bdboard-b' },
        { issueId: 'bdboard-b', dependsOnId: 'bdboard-a' },
      ]),
    ).toBe(
      "bd dep remove 'bdboard-a' 'bdboard-b'\n" +
        "bd dep remove 'bdboard-b' 'bdboard-a'",
    );
  });

  it('includes -C when rootPath is provided', () => {
    expect(
      formatDependencyCycleRemovalScript(
        [{ issueId: 'bdboard-a', dependsOnId: 'bdboard-b' }],
        '/repo/root',
      ),
    ).toBe("bd -C '/repo/root' dep remove 'bdboard-a' 'bdboard-b'");
  });
});
