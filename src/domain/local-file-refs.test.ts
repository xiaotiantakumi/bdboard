import { describe, expect, it } from 'vitest';
import { extractLocalFileCandidateLines, localFileResolutionAttempts } from './local-file-refs.js';

const SYNTHETIC_BODY = [
  '- 台本：projects/demo/script/scenes.json（レビュー表：script/review.md）',
  '- 静止画 12 枚：out/13-demo/stills/（s01〜s29・outro）',
  '- 耳確認用の動画：out/13-demo/reading-review.mp4（疑い 15 件）',
  '- 概要欄：channel/uploads/13-demo/upload.md（upload.json。youtube:check は …）',
  '- サムネ案：projects/demo/thumbnail.json',
  "直し方の案：npm run narration -- --project demo --budget '0.05'。readings.json で直せない語は …",
].join('\n');

describe('extractLocalFileCandidateLines', () => {
  it('extracts the synthetic body in appearance order', () => {
    expect(extractLocalFileCandidateLines(SYNTHETIC_BODY)).toEqual([
      ['projects/demo/script/scenes.json', 'script/review.md'],
      ['out/13-demo/stills'],
      ['out/13-demo/reading-review.mp4'],
      ['channel/uploads/13-demo/upload.md', 'upload.json'],
      ['projects/demo/thumbnail.json'],
      ['readings.json'],
    ]);
  });

  it.each([
    '0.05',
    '1.1',
    'npm',
    '--project',
    'https://example.com/docs/a.md',
    '../secret.md',
    '.env',
    '.git/config',
    'a/.hidden/b.md',
    '/etc/passwd.txt',
    '~/notes/a.md',
    '~notes/a.md',
    'a//b.md',
  ])('drops %j', (text) => {
    expect(extractLocalFileCandidateLines(text)).toEqual([[]]);
  });

  it.each([
    ['see docs/a.md.', 'docs/a.md'],
    ['see docs/a.md,', 'docs/a.md'],
  ])('strips trailing punctuation from %j', (text, expected) => {
    expect(extractLocalFileCandidateLines(text)).toEqual([[expected]]);
  });

  it('keeps an uppercase allowed extension', () => {
    expect(extractLocalFileCandidateLines('IMG.PNG')).toEqual([['IMG.PNG']]);
  });

  it('returns one empty line for an empty string', () => {
    expect(extractLocalFileCandidateLines('')).toEqual([[]]);
  });

  it('keeps a trailing newline as its own empty line', () => {
    expect(extractLocalFileCandidateLines('\n')).toEqual([[], []]);
    expect(extractLocalFileCandidateLines('\r\n')).toEqual([[], []]);
  });

  it('splits CRLF into separate lines', () => {
    expect(extractLocalFileCandidateLines('a.json\r\nb.md')).toEqual([['a.json'], ['b.md']]);
  });
});

describe('localFileResolutionAttempts', () => {
  it('tries the root, then ancestors of the previous file from nearest', () => {
    expect(
      localFileResolutionAttempts('script/review.md', {
        path: 'projects/demo/script/scenes.json',
        isDirectory: false,
      }),
    ).toEqual([
      'script/review.md',
      'projects/demo/script/script/review.md',
      'projects/demo/script/review.md',
      'projects/script/review.md',
    ]);
  });

  it('tries only the previous file directory for a bare name', () => {
    expect(
      localFileResolutionAttempts('upload.json', {
        path: 'channel/uploads/13-demo/upload.md',
        isDirectory: false,
      }),
    ).toEqual(['upload.json', 'channel/uploads/13-demo/upload.json']);
  });

  it('tries the previous directory itself for a bare name', () => {
    expect(
      localFileResolutionAttempts('s01.png', {
        path: 'out/13-demo/stills',
        isDirectory: true,
      }),
    ).toEqual(['s01.png', 'out/13-demo/stills/s01.png']);
  });

  it('returns only the candidate when nothing was resolved earlier', () => {
    expect(localFileResolutionAttempts('script/review.md', undefined)).toEqual(['script/review.md']);
  });

  it('adds no prefix when the previous file sits directly under the root', () => {
    expect(
      localFileResolutionAttempts('script/review.md', { path: 'a.md', isDirectory: false }),
    ).toEqual(['script/review.md']);
  });
});
