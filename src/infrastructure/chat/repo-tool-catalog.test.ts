import { describe, expect, it } from 'vitest';
import {
  REPO_TOOL_DEFINITIONS,
  buildRepoToolArgs,
  applyRepoOutputFilter,
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
    expect(result.outputFilter).toEqual({ kind: 'commits', ticketId: 'bdboard-3tw.151' });
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
    expect(result.outputFilter).toEqual({
      kind: 'paths',
      needle: 'sync-health',
      maxMatches: 200,
    });
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

describe('applyRepoOutputFilter / commits (PR#143 レビュー major-1)', () => {
  const log = [
    '01d780b 2026-08-29 fix(bdboard-x32): 自己再注入では .gitignore へ追記しない (#138)',
    '5a9b943 2026-08-29 feat(bdboard-3tw.156): 取りこぼした返信を拾う (#135)',
    '',
  ].join('\n');

  it('drops a commit that only matched because the id is a prefix of a longer one', () => {
    // git の --grep は境界の無い部分一致なので、bdboard-x3 は bdboard-x32 の
    // コミットに当たってしまう(実測)。ここで落とすのがこのフィルタの本題。
    expect(applyRepoOutputFilter(log, { kind: 'commits', ticketId: 'bdboard-x3' })).toBe(
      'commits=0 grepped=2',
    );
  });

  it('keeps the commit for the exact id', () => {
    const output = applyRepoOutputFilter(log, {
      kind: 'commits',
      ticketId: 'bdboard-x32',
    });
    expect(output.split('\n')[0]).toBe('commits=1 grepped=2');
    expect(output).toContain('fix(bdboard-x32)');
  });

  it('does not let a parent epic id claim its child ticket commit', () => {
    expect(
      applyRepoOutputFilter(log, { kind: 'commits', ticketId: 'bdboard-3tw.15' }),
    ).toBe('commits=0 grepped=2');
    expect(
      applyRepoOutputFilter(log, { kind: 'commits', ticketId: 'bdboard-3tw.156' }),
    ).toContain('commits=1');
  });

  it('accepts an id followed by punctuation that is not part of an id', () => {
    for (const subject of [
      'abc1234 2026-08-29 Closes bdboard-x32.',
      'abc1234 2026-08-29 bdboard-x32: done',
      'abc1234 2026-08-29 done (bdboard-x32)',
    ]) {
      expect(
        applyRepoOutputFilter(`${subject}\n`, {
          kind: 'commits',
          ticketId: 'bdboard-x32',
        }),
      ).toContain('commits=1');
    }
  });
});

describe('applyRepoOutputFilter / paths', () => {
  const stdout = ['web/src/SyncHealth.tsx', 'src/main.ts', 'docs/sync-health.md', ''].join(
    '\n',
  );

  it('reports matches with the scanned total so 0 means "really gone"', () => {
    expect(
      applyRepoOutputFilter(stdout, {
        kind: 'paths',
        needle: 'sync-health',
        maxMatches: 200,
      }),
    ).toBe('matched=1 scanned=3\ndocs/sync-health.md');
    expect(
      applyRepoOutputFilter(stdout, {
        kind: 'paths',
        needle: 'nothing-here',
        maxMatches: 200,
      }),
    ).toBe('matched=0 scanned=3');
  });

  it('matches case-insensitively', () => {
    expect(
      applyRepoOutputFilter(stdout, {
        kind: 'paths',
        needle: 'synchealth',
        maxMatches: 200,
      }),
    ).toContain('web/src/SyncHealth.tsx');
  });

  it('says so when the match list is truncated', () => {
    const many = `${Array.from({ length: 5 }, (_, index) => `src/a${index}.ts`).join('\n')}\n`;
    const output = applyRepoOutputFilter(many, {
      kind: 'paths',
      needle: 'src/a',
      maxMatches: 2,
    });

    expect(output.split('\n')[0]).toBe('matched=5 scanned=5 truncated=true shown=2');
    expect(output.split('\n')).toHaveLength(3);
  });
});

describe('applyRepoOutputFilter / truncated stdout (PR#143 レビュー minor-3)', () => {
  // CommandRunner の stdout 上限に当たると git の出力は行の途中で切れる。
  // git は各行を必ず改行で終えるので、末尾に改行が無い = 切れた、と判定できる。
  it('marks the result incomplete and drops the half-written last line', () => {
    const output = applyRepoOutputFilter('src/a.ts\nsrc/b.ts\nsrc/b', {
      kind: 'paths',
      needle: 'src/b',
      maxMatches: 200,
    });

    expect(output).toBe('matched=1 scanned=2 incomplete=true\nsrc/b.ts');
  });

  it('does not mark a properly terminated output incomplete', () => {
    expect(
      applyRepoOutputFilter('src/a.ts\n', {
        kind: 'paths',
        needle: 'src',
        maxMatches: 200,
      }),
    ).not.toContain('incomplete');
    expect(
      applyRepoOutputFilter('', { kind: 'paths', needle: 'src', maxMatches: 200 }),
    ).toBe('matched=0 scanned=0');
  });

  it('marks a truncated commit listing incomplete too', () => {
    expect(
      applyRepoOutputFilter('abc1234 2026-08-29 fix(bdboard-x32): a\ndef56', {
        kind: 'commits',
        ticketId: 'bdboard-x32',
      }),
    ).toBe('commits=1 grepped=1 incomplete=true\nabc1234 2026-08-29 fix(bdboard-x32): a');
  });
});
