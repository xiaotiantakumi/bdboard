import { describe, expect, it } from 'vitest';
import {
  SELF_ERROR_MIN_NAME_LENGTH,
  createSelfErrorMasker,
  maskSelfErrorText,
} from './self-error-mask.js';
import type { SelfErrorMaskProject } from './self-error-mask.js';
import { LINEAR_TIME_TEST_TIMEOUT_MS, expectLinearTime } from './linear-time-test-support.js';

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

  it('does not match a longer name', () => {
    const text = '/work/example-root2 /work/example-root_old /work/example-root-x /work/example-rootÉ';
    expect(mask(text)).toBe(text);
  });

  it('matches whatever comes before the path (glued flags, real-path prefixes)', () => {
    expect(mask('bd -C/work/example-root list')).toBe('bd -C<project-root> list');
    expect(mask('open /System/Volumes/Data/work/example-root/x')).toBe('open /System/Volumes/Data<project-root>/x');
    expect(mask('/srv/work/example-root')).toBe('/srv<project-root>');
  });

  it('matches the percent-encoded form of a path and a name', () => {
    const spaced = project({ name: '業務アプリ', rootPath: '/work/my proj', aliasPaths: [] });
    expect(mask('see file:///work/my%20proj/x', spaced)).toBe('see file://<project-root>/x');
    expect(mask(`see ${encodeURIComponent('業務アプリ')}.db`, spaced)).toBe('see <project>.db');
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

  it('masks the Dolt database name, which bd makes from the prefix (`-` and `.` become `_`)', () => {
    // 実データの形: フォルダ名と接頭辞が違うプロジェクトでは、#432 の文に出るのは接頭辞から作ったデータベース名。
    const mogu = project({ name: 'MoguExercise', rootPath: '/work/MoguExercise', aliasPaths: [], prefixes: ['epic-haslett-00ae14'] });
    expect(mask('database "epic_haslett_00ae14" not found on dolt server at 127.0.0.1:60813', mogu)).toBe(
      'database "<project>" not found on dolt server at 127.0.0.1:60813',
    );
    const personal = project({ name: 'personal-todo', rootPath: '/work/personal-todo', aliasPaths: [], prefixes: ['personal'] });
    expect(mask('database "personal" not found', personal)).toBe('database "<project>" not found');
    expect(mask('database "personal_todo" and beads_my_app.x', personal, project({ name: 'my.app', prefixes: [] }))).toBe(
      'database "<project>" and beads_<project>.x',
    );
  });

  it('leaves a bare prefix shorter than three code points alone (the bd command stays readable)', () => {
    const short = project({ name: 'unrelated-name', prefixes: ['bd'] });
    expect(mask('run bd doctor; bd-abc failed', short)).toBe('run bd doctor; <ticket-id> failed');
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

  it('masks a prefix without an id as the project, not as a ticket id', () => {
    expect(mask('bdboard- bdboard', tickets)).toBe('<project>- <project>');
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

  // 壁時計の絶対値ではなく、同じ形を 1/10 の長さと元の長さで測った CPU 時間の比で線形を見る (bdboard-0101)。
  it('handles a hundred thousand characters that almost match in time linear in their length', () => {
    expectLinearTime('self-error-mask: almost-matching 100k input', (n) => {
      const text = 'a'.repeat(n(100_000));
      return () => {
        expect(mask(text, adversarial)).toBe(text);
      };
    });
  }, LINEAR_TIME_TEST_TIMEOUT_MS);

  it('handles tens of thousands of matches in time linear in their number', () => {
    expectLinearTime('self-error-mask: 30k matches', (n) => {
      const text = 'aaa '.repeat(n(30_000));
      const expected = '<project> '.repeat(n(30_000));
      return () => {
        expect(mask(text, adversarial)).toBe(expected);
      };
    });
  }, LINEAR_TIME_TEST_TIMEOUT_MS);

  it('handles a path whose separators repeat in time linear in their number', () => {
    expectLinearTime('self-error-mask: repeated separators', (n) => {
      const slashes = '/'.repeat(n(50_000));
      const root = project({ rootPath: `/w${slashes}`, aliasPaths: [], name: 'zz', prefixes: [] });
      const text = `/w/${slashes}x`;
      return () => {
        expect(mask(text, root)).toBe(`<project-root>/${slashes}x`);
      };
    });
  }, LINEAR_TIME_TEST_TIMEOUT_MS);
});
