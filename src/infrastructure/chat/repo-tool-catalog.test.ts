import { describe, expect, it } from 'vitest';
import {
  REPO_TOOL_DEFINITIONS,
  buildRepoToolArgs,
  filterRepoPaths,
  isRepoToolName,
} from './repo-tool-catalog.js';

const PROJECT_ROOT = '/tmp/bdboard-repo-tool-test';

function expectOk(result: ReturnType<typeof buildRepoToolArgs>) {
  if (!result.ok) {
    throw new Error(`expected ok, got: ${result.error}`);
  }
  return result;
}

describe('REPO_TOOL_DEFINITIONS', () => {
  it('exposes exactly the two readonly evidence tools', () => {
    expect(REPO_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'repo_ticket_landed',
      'repo_path_exists',
    ]);
    expect(REPO_TOOL_DEFINITIONS.every((tool) => tool.writes === false)).toBe(true);
  });

  it('recognises only its own tool names', () => {
    expect(isRepoToolName('repo_ticket_landed')).toBe(true);
    expect(isRepoToolName('repo_path_exists')).toBe(true);
    expect(isRepoToolName('bd_close')).toBe(false);
    expect(isRepoToolName('repo_push')).toBe(false);
  });
});

describe('buildRepoToolArgs / repo_ticket_landed', () => {
  it('greps origin/main for the ticket id as a fixed string', () => {
    const result = expectOk(
      buildRepoToolArgs('repo_ticket_landed', { ticketId: 'bdboard-3tw.151' }, PROJECT_ROOT),
    );

    expect(result.args).toEqual([
      '-C',
      PROJECT_ROOT,
      '--no-pager',
      'log',
      '--max-count=20',
      '--fixed-strings',
      '--grep=bdboard-3tw.151',
      '--date=short',
      '--format=%h %ad %s',
      'origin/main',
      '--',
    ]);
    expect(result.pathFilter).toBeUndefined();
  });

  it('keeps --fixed-strings so a dotted id cannot match a different ticket', () => {
    // チケットIDの `.` を正規表現として解釈させると bdboard-3tw151 まで拾ってしまう。
    const result = expectOk(
      buildRepoToolArgs('repo_ticket_landed', { ticketId: 'bdboard-3tw.151' }, PROJECT_ROOT),
    );
    expect(result.args).toContain('--fixed-strings');
  });

  it('accepts an explicit ref for repos whose default branch is not main', () => {
    const result = expectOk(
      buildRepoToolArgs(
        'repo_ticket_landed',
        { ticketId: 'bdboard-3tw.151', ref: 'origin/master' },
        PROJECT_ROOT,
      ),
    );
    expect(result.args).toContain('origin/master');
    expect(result.args).not.toContain('origin/main');
  });

  it('rejects an invalid ticket id', () => {
    const result = buildRepoToolArgs(
      'repo_ticket_landed',
      { ticketId: '--output=/tmp/pwned' },
      PROJECT_ROOT,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects refs that could turn into options or ranges', () => {
    for (const ref of ['--upload-pack=sh', '-x', 'origin/main..HEAD', 'a b', '']) {
      const result = buildRepoToolArgs(
        'repo_ticket_landed',
        { ticketId: 'bdboard-3tw.151', ref },
        PROJECT_ROOT,
      );
      expect(result.ok, `ref should be rejected: ${JSON.stringify(ref)}`).toBe(false);
    }
  });

  it('rejects unknown keys', () => {
    const result = buildRepoToolArgs(
      'repo_ticket_landed',
      { ticketId: 'bdboard-3tw.151', extra: 1 },
      PROJECT_ROOT,
    );
    expect(result.ok).toBe(false);
  });
});

describe('buildRepoToolArgs / repo_path_exists', () => {
  it('lists the tree of origin/main and asks for a case-insensitive filter', () => {
    const result = expectOk(
      buildRepoToolArgs('repo_path_exists', { pattern: 'Sync-Health' }, PROJECT_ROOT),
    );

    expect(result.args).toEqual([
      '-C',
      PROJECT_ROOT,
      '--no-pager',
      'ls-tree',
      '-r',
      '--name-only',
      'origin/main',
      '--',
    ]);
    // パターンは git へ渡さない。渡すのは呼び出し側での絞り込み指示だけ。
    expect(result.args.join(' ')).not.toContain('Sync-Health');
    expect(result.pathFilter).toEqual({ needle: 'sync-health', maxMatches: 200 });
  });

  it('rejects an empty, over-long, or control-character pattern', () => {
    expect(buildRepoToolArgs('repo_path_exists', { pattern: '' }, PROJECT_ROOT).ok).toBe(
      false,
    );
    expect(
      buildRepoToolArgs('repo_path_exists', { pattern: 'x'.repeat(201) }, PROJECT_ROOT).ok,
    ).toBe(false);
    expect(
      buildRepoToolArgs('repo_path_exists', { pattern: 'a\nb' }, PROJECT_ROOT).ok,
    ).toBe(false);
  });
});

describe('buildRepoToolArgs / allowlist', () => {
  it('never produces a git subcommand other than log or ls-tree', () => {
    for (const tool of REPO_TOOL_DEFINITIONS) {
      const rawArgs =
        tool.name === 'repo_ticket_landed'
          ? { ticketId: 'bdboard-3tw.151' }
          : { pattern: 'src' };
      const result = expectOk(buildRepoToolArgs(tool.name, rawArgs, PROJECT_ROOT));
      // ['-C', root, '--no-pager', <subcommand>, ...]
      expect(['log', 'ls-tree']).toContain(result.args[3]);
    }
  });

  it('rejects write-flavoured tool names outright', () => {
    for (const name of [
      'repo_push',
      'repo_commit',
      'repo_checkout',
      'git',
      'repo_ticket_landed ',
    ]) {
      const result = buildRepoToolArgs(name, {}, PROJECT_ROOT);
      expect(result.ok, `should reject ${name}`).toBe(false);
    }
  });
});

describe('filterRepoPaths', () => {
  const stdout = ['web/src/SyncHealth.tsx', 'src/main.ts', 'docs/sync-health.md', ''].join(
    '\n',
  );

  it('reports matches with the scanned total so 0 means "really gone"', () => {
    expect(filterRepoPaths(stdout, { needle: 'sync-health', maxMatches: 200 })).toBe(
      'matched=1 scanned=3\ndocs/sync-health.md',
    );
    expect(filterRepoPaths(stdout, { needle: 'nothing-here', maxMatches: 200 })).toBe(
      'matched=0 scanned=3',
    );
  });

  it('matches case-insensitively', () => {
    expect(filterRepoPaths(stdout, { needle: 'synchealth', maxMatches: 200 })).toContain(
      'web/src/SyncHealth.tsx',
    );
  });

  it('says so when the match list is truncated', () => {
    const many = Array.from({ length: 5 }, (_, index) => `src/a${index}.ts`).join('\n');
    const output = filterRepoPaths(many, { needle: 'src/a', maxMatches: 2 });

    expect(output.split('\n')[0]).toBe('matched=5 scanned=5 truncated=true shown=2');
    expect(output.split('\n')).toHaveLength(3);
  });
});
