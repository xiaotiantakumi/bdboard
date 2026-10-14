import { describe, expect, it } from 'vitest';
import { buildLocalFileViewerUrl, localFileNameOf, parseLocalFileViewerRoute } from './localFileViewerRoute';

const SCENE = {
  ticketId: 'video-p4q.38',
  path: 'projects/demo/script/scenes.json',
  kind: 'json' as const,
  size: 1200,
};

describe('local file viewer route', () => {
  it('round-trips a plain ASCII path through the query string', () => {
    const url = buildLocalFileViewerUrl(SCENE);
    expect(url).toBe(
      '/?view=local-file&ticket=video-p4q.38&path=projects%2Fdemo%2Fscript%2Fscenes.json&kind=json&size=1200',
    );
    expect(url.includes('#')).toBe(false);
    expect(parseLocalFileViewerRoute(url.slice(1))).toEqual(SCENE);
  });

  it('omits size when it is missing or null, and keeps a directory path', () => {
    const input = {
      ticketId: 'video-p4q.38',
      path: 'out/13-demo/stills',
      kind: 'directory' as const,
    };
    const url = buildLocalFileViewerUrl(input);
    expect(url).toBe(
      '/?view=local-file&ticket=video-p4q.38&path=out%2F13-demo%2Fstills&kind=directory',
    );
    expect(parseLocalFileViewerRoute(`?${url.slice(2)}`)).toEqual(input);
    expect(buildLocalFileViewerUrl({ ...input, size: null })).toBe(url);
  });

  it('keeps size 0 and drops a non-integer size instead of writing null', () => {
    const withZero = buildLocalFileViewerUrl({ ...SCENE, size: 0 });
    expect(parseLocalFileViewerRoute(withZero.slice(1))).toEqual({ ...SCENE, size: 0 });

    const dropped = parseLocalFileViewerRoute(
      '?view=local-file&ticket=video-p4q.38&path=projects/demo/thumbnail.json&kind=json&size=1.5',
    );
    expect(dropped).toEqual({
      ticketId: 'video-p4q.38',
      path: 'projects/demo/thumbnail.json',
      kind: 'json',
    });
    expect(dropped?.size).toBeUndefined();
  });

  it.each([
    '?view=board&ticket=video-p4q.38&path=a.json&kind=json',
    '?ticket=video-p4q.38&path=a.json&kind=json',
    '?view=local-file&path=a.json&kind=json',
    '?view=local-file&ticket=&path=a.json&kind=json',
    '?view=local-file&ticket=video-p4q.38&kind=json',
    '?view=local-file&ticket=video-p4q.38&path=&kind=json',
    '?view=local-file&ticket=video-p4q.38&path=a.svg&kind=svg',
    '?view=local-file&ticket=video-p4q.38&path=a.html&kind=html',
    '',
  ])('returns null for %s', (search) => {
    expect(parseLocalFileViewerRoute(search)).toBeNull();
  });

  it('takes the last path segment as the file name', () => {
    expect(localFileNameOf('out/13-demo/stills/s01.png')).toBe('s01.png');
    expect(localFileNameOf('projects/demo/thumbnail.json')).toBe('thumbnail.json');
  });

  it('treats a negative or non-numeric size as undefined, not null', () => {
    for (const size of ['-1', 'abc', '']) {
      const parsed = parseLocalFileViewerRoute(
        `?view=local-file&ticket=video-p4q.38&path=channel/uploads/13-demo/upload.md&kind=markdown&size=${size}`,
      );
      expect(parsed).toEqual({
        ticketId: 'video-p4q.38',
        path: 'channel/uploads/13-demo/upload.md',
        kind: 'markdown',
      });
      expect(parsed).not.toHaveProperty('size');
    }
  });
});
