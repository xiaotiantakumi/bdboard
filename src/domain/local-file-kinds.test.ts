import { describe, expect, it } from 'vitest';
import {
  LOCAL_FILE_RANGE_CHUNK_BYTES,
  localFileTypeForPath,
  localFileUnrangedBodyLimitBytes,
  type LocalFileContentKind,
} from './local-file-kinds.js';

const MIB = 1024 * 1024;

describe('localFileTypeForPath', () => {
  it.each<[string, LocalFileContentKind, string]>([
    ['shot.png', 'image', 'image/png'],
    ['dir/shot.jpg', 'image', 'image/jpeg'],
    ['dir/shot.jpeg', 'image', 'image/jpeg'],
    ['dir/shot.webp', 'image', 'image/webp'],
    ['dir/shot.gif', 'image', 'image/gif'],
    ['out/13-demo/reading-review.mp4', 'video', 'video/mp4'],
    ['clip.webm', 'video', 'video/webm'],
    ['clip.m4v', 'video', 'video/x-m4v'],
    ['clip.mov', 'video', 'video/quicktime'],
    ['ear.mp3', 'audio', 'audio/mpeg'],
    ['ear.m4a', 'audio', 'audio/mp4'],
    ['ear.wav', 'audio', 'audio/wav'],
    ['script/review.md', 'markdown', 'text/markdown; charset=utf-8'],
    ['projects/demo/thumbnail.json', 'json', 'application/json; charset=utf-8'],
    ['notes.txt', 'text', 'text/plain; charset=utf-8'],
    ['table.csv', 'text', 'text/csv; charset=utf-8'],
    ['captions.srt', 'text', 'text/plain; charset=utf-8'],
    ['captions.vtt', 'text', 'text/vtt; charset=utf-8'],
  ])('maps %s to %s %s', (path, kind, contentType) => {
    expect(localFileTypeForPath(path)).toEqual({ kind, contentType });
  });

  it('reads the last segment extension case-insensitively', () => {
    expect(localFileTypeForPath('stills/A.PNG')).toEqual({
      kind: 'image',
      contentType: 'image/png',
    });
    expect(localFileTypeForPath('notes.backup.MD')).toEqual({
      kind: 'markdown',
      contentType: 'text/markdown; charset=utf-8',
    });
    expect(localFileTypeForPath('notes.md/photo.jpeg')).toEqual({
      kind: 'image',
      contentType: 'image/jpeg',
    });
  });

  it.each(['icon.svg', 'page.html', 'src/app.ts', 'Makefile', '.env', 'dir/.env', '.png', 'file.', 'archive.tar.gz'])(
    'returns undefined for %s',
    (path) => {
      expect(localFileTypeForPath(path)).toBeUndefined();
    },
  );
});

describe('local file byte limits', () => {
  it('caps one open-ended range read at 4 MiB', () => {
    expect(LOCAL_FILE_RANGE_CHUNK_BYTES).toBe(4 * MIB);
  });

  it('caps an unranged 200 body by kind', () => {
    expect(localFileUnrangedBodyLimitBytes('markdown')).toBe(2 * MIB);
    expect(localFileUnrangedBodyLimitBytes('json')).toBe(2 * MIB);
    expect(localFileUnrangedBodyLimitBytes('text')).toBe(2 * MIB);
    expect(localFileUnrangedBodyLimitBytes('image')).toBe(30 * MIB);
    expect(localFileUnrangedBodyLimitBytes('video')).toBe(4 * MIB);
    expect(localFileUnrangedBodyLimitBytes('audio')).toBe(4 * MIB);
  });
});
