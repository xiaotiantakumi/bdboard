import { describe, expect, it } from 'vitest';
import {
  SELF_ERROR_MIN_NAME_LENGTH,
  createSelfErrorMasker,
  maskSelfErrorText,
} from './self-error-mask.js';
import type { SelfErrorMaskProject } from './self-error-mask.js';

function project(overrides: Partial<SelfErrorMaskProject> = {}): SelfErrorMaskProject {
  return {
    name: 'example-project',
    rootPath: '/work/example-root',
    aliasPaths: ['/alias/example-root'],
    prefixes: ['exa'],
    ...overrides,
  };
}

function mask(text: string, ...projects: SelfErrorMaskProject[]): string {
  return maskSelfErrorText(text, projects.length > 0 ? projects : [project()]);
}

describe('project paths', () => {
  it('replaces the root and the alias paths, keeping what follows', () => {
    expect(mask('open /work/example-root/src/x.ts')).toBe('open <project-root>/src/x.ts');
    expect(mask('open /alias/example-root/.beads')).toBe('open <project-root>/.beads');
  });

  it('replaces a root that is written with trailing separators', () => {
    const trailing = project({ rootPath: '/work/example-root//', aliasPaths: [] });
    expect(mask('open /work/example-root/src', trailing)).toBe('open <project-root>/src');
    expect(mask('open /work/example-root', trailing)).toBe('open <project-root>');
  });

  it('matches at punctuation, quotes and the end of a sentence', () => {
    expect(mask("ENOENT: open '/work/example-root/.beads': failed")).toBe("ENOENT: open '<project-root>/.beads': failed");
    expect(mask('see /work/example-root.')).toBe('see <project-root>.');
  });

  it('does not match a longer name, nor the tail of a longer path', () => {
    const text = '/work/example-root2 /work/example-root_old /work/example-root-x /srv/work/example-root /work/example-rootÉ';
    expect(mask(text)).toBe(text);
  });

  it('matches without regard to case', () => {
    expect(mask('/WORK/Example-Root/x')).toBe('<project-root>/x');
  });

  it('matches the backslash, JSON-escaped and decomposed forms', () => {
    const windows = project({ rootPath: 'C:\\work\\example-root', aliasPaths: [] });
    expect(mask('open C:\\work\\example-root\\src', windows)).toBe('open <project-root>\\src');
    expect(mask('{"path":"C:\\\\work\\\\example-root\\\\src"}', windows)).toBe('{"path":"<project-root>\\\\src"}');
    expect(mask('open C:/work/example-root/src', windows)).toBe('open <project-root>/src');
    const accented = project({ rootPath: '/work/équipe', aliasPaths: [] });
    expect(mask(`open ${'/work/équipe'.normalize('NFD')}/src`, accented)).toBe('open <project-root>/src');
    expect(mask(`open ${'/work/équipe'.normalize('NFC')}/src`, accented)).toBe('open <project-root>/src');
  });

  it('prefers the longest path when the alias lives inside the root', () => {
    const nested = project({ rootPath: '/w/app', aliasPaths: ['/w/app/sub'] });
    expect(mask('open /w/app/sub/x and /w/app/y', nested)).toBe('open <project-root>/x and <project-root>/y');
  });

  it('never searches for a root that is empty or only separators', () => {
    const odd = project({ rootPath: '/', aliasPaths: ['', '\\', '//'], name: 'zz', prefixes: [] });
    expect(mask('/usr/local/bin and a/b', odd)).toBe('/usr/local/bin and a/b');
  });

  it('treats regular-expression characters in a path literally', () => {
    const special = project({ rootPath: '/w/(x)+[y].z', aliasPaths: [] });
    expect(mask('open /w/(x)+[y].z/src and /w/xxy_z', special)).toBe('open <project-root>/src and /w/xxy_z');
  });
});

describe('project names', () => {
  it('masks the database name in the #432 sentence and keeps the port', () => {
    expect(mask('database "example-project" not found on dolt server at 127.0.0.1:3307')).toBe(
      'database "<project>" not found on dolt server at 127.0.0.1:3307',
    );
  });

  it('matches only at a word boundary', () => {
    expect(mask('exampleproject2 myexample-projectx example-projects')).toBe('exampleproject2 myexample-projectx example-projects');
    expect(mask('(example-project)')).toBe('(<project>)');
  });

  it('treats an underscore and a hyphen as boundaries, so decorated database names are masked', () => {
    expect(mask('beads_example-project example-project-server')).toBe('beads_<project> <project>-server');
  });

  it('masks a name inside text that is not separated by spaces', () => {
    expect(mask('サーバーexample-projectを開けない')).toBe('サーバー<project>を開けない');
  });

  it('matches without regard to case', () => {
    expect(mask('EXAMPLE-PROJECT / Example-Project')).toBe('<project> / <project>');
  });

  it('leaves names shorter than three code points alone and masks three', () => {
    expect(SELF_ERROR_MIN_NAME_LENGTH).toBe(3);
    expect(mask('ab ab', project({ name: 'ab' }))).toBe('ab ab');
    expect(mask('日本 日本', project({ name: '日本' }))).toBe('日本 日本');
    // 補助面の字は UTF-16 では 2 単位だが、数えるのはコードポイント。
    expect(mask('𠮷野 𠮷野', project({ name: '𠮷野' }))).toBe('𠮷野 𠮷野');
    expect(mask('abc', project({ name: 'abc' }))).toBe('<project>');
    expect(mask('日本語', project({ name: '日本語' }))).toBe('<project>');
  });

  it('ignores empty names and trims surrounding whitespace before counting', () => {
    const quiet = project({ name: '', rootPath: '/nowhere', aliasPaths: [], prefixes: [] });
    expect(mask('anything  at all', quiet)).toBe('anything  at all');
    expect(mask('ab and abc', project({ name: '  ab  ' }))).toBe('ab and abc');
    expect(mask('ab and abc', project({ name: '  abc  ' }))).toBe('ab and <project>');
  });

  it('treats regular-expression characters in a name literally', () => {
    const special = project({ name: 'a.b*c' });
    expect(mask('a.b*c aXbbc', special)).toBe('<project> aXbbc');
  });
});

describe('ticket ids', () => {
  const tickets = project({ name: 'unrelated-name', prefixes: ['bdboard', 'other'] });

  it('masks ids that start with a prefix, children and hierarchy included', () => {
    expect(mask('see bdboard-4y8q.6.2 and bdboard-abc and other-x1', tickets)).toBe('see <ticket-id> and <ticket-id> and <ticket-id>');
  });

  it('keeps a trailing sentence period', () => {
    expect(mask('failed on bdboard-abc.', tickets)).toBe('failed on <ticket-id>.');
    expect(mask('bdboard-abc, bdboard-def)', tickets)).toBe('<ticket-id>, <ticket-id>)');
  });

  it('does not match a prefix inside a longer word', () => {
    expect(mask('xbdboard-abc 9bdboard-abc', tickets)).toBe('xbdboard-abc 9bdboard-abc');
  });

  it('does not mask a prefix without an id', () => {
    expect(mask('bdboard- bdboard', tickets)).toBe('bdboard- bdboard');
  });

  it('matches without regard to case', () => {
    expect(mask('BDBoard-ABC', tickets)).toBe('<ticket-id>');
  });

  it('ignores prefixes that are empty, contain whitespace or end with a hyphen', () => {
    const bad = project({ name: 'unrelated-name', prefixes: ['', 'bad prefix', 'trailing-'] });
    expect(mask('bad prefix-abc trailing--abc -abc', bad)).toBe('bad prefix-abc trailing--abc -abc');
  });

  it('treats regular-expression characters in a prefix literally', () => {
    const special = project({ name: 'unrelated-name', prefixes: ['c++'] });
    expect(mask('c++-id and cc-id', special)).toBe('<ticket-id> and cc-id');
  });
});

describe('priority and marks', () => {
  it('lets the path win over the name inside it', () => {
    const inner = project({ name: 'example-project', rootPath: '/work/example-project' });
    expect(mask('open /work/example-project/src for example-project', inner)).toBe('open <project-root>/src for <project>');
  });

  it('lets the ticket id win over a name that is also the prefix', () => {
    const same = project({ name: 'bdboard', prefixes: ['bdboard'] });
    expect(mask('database "bdboard" and bdboard-4y8q.6.2', same)).toBe('database "<project>" and <ticket-id>');
  });

  it('does not search again inside the marks it inserted', () => {
    const tricky = project({ name: 'project', rootPath: '/work/project', aliasPaths: [], prefixes: ['ticket'] });
    expect(mask('/work/project/src ticket-abc project', tricky)).toBe('<project-root>/src <ticket-id> <project>');
    // 印の中の `project` や `ticket` が、そのまま残った名前と取り違えられて 2 重に置き換わらない。
    expect(mask('/work/project/src', tricky)).not.toContain('<<');
  });

  it('masks every occurrence', () => {
    expect(mask('example-project example-project /work/example-root /work/example-root')).toBe(
      '<project> <project> <project-root> <project-root>',
    );
  });
});

describe('several projects', () => {
  const alpha = project({ name: 'alpha-project', rootPath: '/work/alpha', aliasPaths: [], prefixes: ['alp'] });
  const beta = project({ name: 'beta-project', rootPath: '/work/beta', aliasPaths: [], prefixes: ['bet'] });

  it('turns the same error from two projects into the same string', () => {
    const forAlpha = maskSelfErrorText('database "alpha-project" not found at /work/alpha (alp-1)', [alpha, beta]);
    const forBeta = maskSelfErrorText('database "beta-project" not found at /work/beta (bet-1)', [alpha, beta]);
    expect(forAlpha).toBe('database "<project>" not found at <project-root> (<ticket-id>)');
    expect(forBeta).toBe(forAlpha);
  });

  it('masks a name that is shared by two projects once', () => {
    const twin = project({ name: 'alpha-project', rootPath: '/work/twin', aliasPaths: [], prefixes: [] });
    expect(maskSelfErrorText('alpha-project', [alpha, twin])).toBe('<project>');
  });
});

describe('createSelfErrorMasker', () => {
  it('returns the text unchanged when there is nothing to look for', () => {
    expect(createSelfErrorMasker([])('unchanged /work/x')).toBe('unchanged /work/x');
    const nothing = project({ name: '', rootPath: '', aliasPaths: [], prefixes: [] });
    expect(createSelfErrorMasker([nothing])('unchanged')).toBe('unchanged');
  });

  it('can be reused for many texts and agrees with maskSelfErrorText', () => {
    const masker = createSelfErrorMasker([project()]);
    for (const text of ['example-project', '/work/example-root/a', 'exa-12', 'plain']) {
      expect(masker(text)).toBe(maskSelfErrorText(text, [project()]));
    }
  });
});

describe('long input', () => {
  const adversarial = project({ name: 'aaa', rootPath: '/nowhere', aliasPaths: [], prefixes: ['aa'] });
  const limitMs = 2000;

  it('handles a hundred thousand characters that almost match', () => {
    const started = Date.now();
    const result = mask('a'.repeat(100_000), adversarial);
    expect(result).toBe('a'.repeat(100_000));
    expect(Date.now() - started).toBeLessThan(limitMs);
  });

  it('handles tens of thousands of matches', () => {
    const started = Date.now();
    const result = mask('aaa '.repeat(30_000), adversarial);
    expect(result).toBe('<project> '.repeat(30_000));
    expect(Date.now() - started).toBeLessThan(limitMs);
  });

  it('handles a path whose separators repeat', () => {
    const slashes = project({ rootPath: `/w${'/'.repeat(50_000)}`, aliasPaths: [], name: 'zz', prefixes: [] });
    const started = Date.now();
    expect(mask(`/w/${'/'.repeat(50_000)}x`, slashes)).toBe(`/w/${'/'.repeat(50_000)}x`.replace('/w', '<project-root>'));
    expect(Date.now() - started).toBeLessThan(limitMs);
  });
});
