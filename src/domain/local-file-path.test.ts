import { describe, expect, it } from 'vitest';
import { normalizeLocalRelativePath } from './local-file-path.js';

describe('normalizeLocalRelativePath', () => {
  it.each<[string, string]>([
    ['out/13-demo/stills/', 'out/13-demo/stills'],
    ['projects/demo/thumbnail.json', 'projects/demo/thumbnail.json'],
    ['静止画/サムネ.png', '静止画/サムネ.png'],
    ['notes/my file.md', 'notes/my file.md'],
  ])('keeps %j as %j', (raw, expected) => {
    expect(normalizeLocalRelativePath(raw)).toBe(expected);
  });

  it.each<[string, string]>([
    ['', 'empty'],
    ['a\0b', 'nul'],
    ['a\nb', 'newline'],
    ['a\tb', 'tab'],
    ['a\u0001b', 'control below 0x20'],
    ['a\u007fb', 'delete'],
    ['a\\b.md', 'backslash'],
    ['/etc/passwd', 'absolute'],
    ['/', 'slash only'],
    ['~/secret', 'home'],
    ['~', 'tilde only'],
    ['foo/../bar', 'parent segment'],
    ['../etc', 'leading parent'],
    ['..', 'parent only'],
    ['a//b', 'empty middle segment'],
    ['a//', 'empty trailing segment'],
    ['.env', 'dotfile'],
    ['.git/config', 'dot directory'],
    ['a/.hidden/b.md', 'hidden middle segment'],
    ['./a.md', 'dot segment'],
    ['.', 'dot only'],
    ['foo/./bar', 'dot segment in the middle'],
  ])('rejects %s (%s)', (raw) => {
    expect(normalizeLocalRelativePath(raw)).toBeUndefined();
  });
});
