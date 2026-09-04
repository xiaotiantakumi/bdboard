import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunRequest } from '../ports/agent-runner.js';
import {
  validateProvisionedRunCwd,
  validateRunRequest,
} from './validate-run-request.js';

// `cwd: '/tmp/project'` は provision 前の要求を表す。worktree 配下への cwd 制約は
// `validateRunRequest` の責務ではなく、provision 後の `validateProvisionedRunCwd`
// が runner へ渡す直前の境界で担う。
function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    ticketId: 'bd-1',
    projectId: 'proj-1',
    cwd: '/tmp/project',
    mode: 'spawn',
    ...overrides,
  };
}

describe('validateRunRequest', () => {
  it('returns null for a valid spawn request', () => {
    expect(validateRunRequest(makeRequest({ mode: 'spawn' }))).toBeNull();
  });

  it('returns null for a valid resume request with sessionId', () => {
    expect(
      validateRunRequest(
        makeRequest({ mode: 'resume', sessionId: 'sess-1' }),
      ),
    ).toBeNull();
  });

  it('rejects resume without sessionId', () => {
    expect(
      validateRunRequest(makeRequest({ mode: 'resume' })),
    ).toBe('invalid-request');
  });

  it('rejects resume with empty sessionId', () => {
    expect(
      validateRunRequest(makeRequest({ mode: 'resume', sessionId: '' })),
    ).toBe('invalid-request');
  });

  it('rejects resume with whitespace-only sessionId', () => {
    expect(
      validateRunRequest(makeRequest({ mode: 'resume', sessionId: '   ' })),
    ).toBe('invalid-request');
  });

  it('rejects empty cwd', () => {
    expect(validateRunRequest(makeRequest({ cwd: '' }))).toBe('invalid-request');
  });

  it('rejects whitespace-only cwd', () => {
    expect(validateRunRequest(makeRequest({ cwd: '  ' }))).toBe(
      'invalid-request',
    );
  });

  it('rejects empty ticketId', () => {
    expect(validateRunRequest(makeRequest({ ticketId: '' }))).toBe(
      'invalid-request',
    );
  });

  it('rejects whitespace-only ticketId', () => {
    expect(validateRunRequest(makeRequest({ ticketId: '  ' }))).toBe(
      'invalid-request',
    );
  });
});

describe('validateProvisionedRunCwd', () => {
  it('returns null for a valid managed worktree path', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/worktrees/bdboard-1',
        '/repo/.claude/worktrees/bdboard-1',
        'bdboard-1',
        '/repo',
      ),
    ).toBeNull();
  });

  it('returns null for a ticket id containing dots', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/worktrees/bdboard-3tw.65',
        '/repo/.claude/worktrees/bdboard-3tw.65',
        'bdboard-3tw.65',
        '/repo',
      ),
    ).toBeNull();
  });

  it('returns null when cwd and worktreePath differ only by trailing slashes', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/worktrees/bdboard-1/',
        '/repo/.claude/worktrees/bdboard-1',
        'bdboard-1',
        '/repo',
      ),
    ).toBeNull();
  });

  it('returns invalid-request when worktreePath is not under .claude/worktrees', () => {
    expect(
      validateProvisionedRunCwd('/tmp/project', '/tmp/project', 'bdboard-1', '/repo'),
    ).toBe('invalid-request');
  });

  it('returns invalid-request when worktree basename does not match ticketId', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/worktrees/other-ticket',
        '/repo/.claude/worktrees/other-ticket',
        'bdboard-1',
        '/repo',
      ),
    ).toBe('invalid-request');
  });

  it('returns invalid-request when parent is not .claude/worktrees', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/other/bdboard-1',
        '/repo/.claude/other/bdboard-1',
        'bdboard-1',
        '/repo',
      ),
    ).toBe('invalid-request');
  });

  it('returns invalid-request when cwd does not match worktreePath', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/worktrees/bdboard-1',
        '/repo/.claude/worktrees/bdboard-2',
        'bdboard-1',
        '/repo',
      ),
    ).toBe('invalid-request');
  });

  it('returns invalid-request when worktreePath is empty', () => {
    expect(
      validateProvisionedRunCwd('/repo/.claude/worktrees/bdboard-1', '', 'bdboard-1', '/repo'),
    ).toBe('invalid-request');
  });

  it('returns invalid-request when ticketId is empty', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/worktrees/bdboard-1',
        '/repo/.claude/worktrees/bdboard-1',
        '',
        '/repo',
      ),
    ).toBe('invalid-request');
  });

  it('rejects a worktree path under a different repository root', () => {
    expect(
      validateProvisionedRunCwd(
        '/other/repo/.claude/worktrees/bdboard-1',
        '/other/repo/.claude/worktrees/bdboard-1',
        'bdboard-1',
        '/repo',
      ),
    ).toBe('invalid-request');
  });

  it('returns invalid-request when ticketId traverses out of the worktrees directory', () => {
    // path.join(repoRoot, '.claude', 'worktrees', '..') normalizes to '<repoRoot>/.claude',
    // so without the basename-drift guard this path would be accepted.
    expect(
      validateProvisionedRunCwd('/repo/.claude', '/repo/.claude', '..', '/repo'),
    ).toBe('invalid-request');
  });

  it('returns invalid-request when repoRoot is empty', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/worktrees/bdboard-1',
        '/repo/.claude/worktrees/bdboard-1',
        'bdboard-1',
        '',
      ),
    ).toBe('invalid-request');
  });

  // nit-3 (bdboard-pkr6.17): path.join が ticketId の区切り文字を畳むと basename が
  // ticketId から乖離する。'/' は全プラットフォームで、'\\' は win32 でだけ区切り。
  it('returns invalid-request when ticketId contains a POSIX path separator', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/worktrees/a/b',
        '/repo/.claude/worktrees/a/b',
        'a/b',
        '/repo',
      ),
    ).toBe('invalid-request');
  });

  it.runIf(process.platform === 'win32')(
    'returns invalid-request when ticketId contains a win32 path separator',
    () => {
      expect(
        validateProvisionedRunCwd(
          'C:\\repo\\.claude\\worktrees\\a\\b',
          'C:\\repo\\.claude\\worktrees\\a\\b',
          'a\\b',
          'C:\\repo',
        ),
      ).toBe('invalid-request');
    },
  );

  describe('normalizePath injection (major-1, bdboard-pkr6.17)', () => {
    // provisioner の findExistingWorktreePath() は `git worktree list --porcelain` の
    // realpath 文字列を返す。scan root が symlink を通るプロジェクト (macOS の
    // /tmp -> /private/tmp など) では、再利用時の worktreePath が realpath になり、
    // repoRoot から組み立てた expected と文字列としては一致しない。
    // フィクスチャは path.resolve/join で組み立てる。POSIX 絶対パスのリテラルだと
    // win32 で path.resolve('/tmp/repo') が 'C:\\tmp\\repo' になり、'/tmp/' で
    // 前方一致する realpath スタブが素通しになって検証にならない。
    const SYMLINK_ROOT = path.resolve('/tmp/repo');
    const REALPATH_ROOT = path.resolve('/private/tmp/repo');
    const reusedWorktreePath = path.join(
      REALPATH_ROOT,
      '.claude',
      'worktrees',
      'bdboard-1',
    );
    /** realpath(3) のスタブ: SYMLINK_ROOT 配下だけを REALPATH_ROOT 配下へ読み替える。 */
    const realpath = (pathValue: string): string =>
      pathValue === SYMLINK_ROOT ||
      pathValue.startsWith(`${SYMLINK_ROOT}${path.sep}`)
        ? `${REALPATH_ROOT}${pathValue.slice(SYMLINK_ROOT.length)}`
        : pathValue;

    it('accepts a reused worktree path that git returned as a realpath', () => {
      expect(
        validateProvisionedRunCwd(
          reusedWorktreePath,
          reusedWorktreePath,
          'bdboard-1',
          SYMLINK_ROOT,
          realpath,
        ),
      ).toBeNull();
    });

    it('rejects the same reused path without normalization (the bug being fixed)', () => {
      expect(
        validateProvisionedRunCwd(
          reusedWorktreePath,
          reusedWorktreePath,
          'bdboard-1',
          SYMLINK_ROOT,
        ),
      ).toBe('invalid-request');
    });

    it('still rejects another repository root after normalization', () => {
      const foreign = path.join(
        path.resolve('/private/tmp/other-repo'),
        '.claude',
        'worktrees',
        'bdboard-1',
      );
      expect(
        validateProvisionedRunCwd(foreign, foreign, 'bdboard-1', SYMLINK_ROOT, realpath),
      ).toBe('invalid-request');
    });

    it('still rejects a cwd that differs from worktreePath after normalization', () => {
      expect(
        validateProvisionedRunCwd(
          path.join(REALPATH_ROOT, '.claude', 'worktrees', 'bdboard-2'),
          reusedWorktreePath,
          'bdboard-1',
          SYMLINK_ROOT,
          realpath,
        ),
      ).toBe('invalid-request');
    });

    it('still rejects ticketId drift when normalizePath is the identity fallback', () => {
      // realpath は存在しないパスで throw するので、実装は入力をそのまま返す
      // フォールバックを持つ。basename ドリフト検査はその影響を受けてはならない。
      expect(
        validateProvisionedRunCwd(
          '/repo/.claude',
          '/repo/.claude',
          '..',
          '/repo',
          (pathValue) => pathValue,
        ),
      ).toBe('invalid-request');
    });
  });
});
