import { describe, expect, it } from 'vitest';
import { createLocalFileRoutes } from './local-file-routes.js';
import {
  createFakeCommentReader,
  createFakeLocalFilesCache,
  createFakeLocalFs,
  LOCAL_FILES_TEST_TICKET_ID,
  requestLocal,
} from './local-file-routes-test-support.js';

const TICKET = LOCAL_FILES_TEST_TICKET_ID;

const SYNTHETIC_DESCRIPTION = [
  '- 台本：projects/demo/script/scenes.json（レビュー表：script/review.md）',
  '- 静止画 12 枚：out/13-demo/stills/（s01〜s29・outro）',
  '- 耳確認用の動画：out/13-demo/reading-review.mp4（疑い 15 件）',
  '- 概要欄：channel/uploads/13-demo/upload.md（upload.json。youtube:check は …）',
  '- サムネ案：projects/demo/thumbnail.json',
  "直し方の案：npm run narration -- --project demo --budget '0.05'。readings.json で直せない語は …",
].join('\n');

function routesFor(
  ticket: { description?: string; notes?: string },
  fs: ReturnType<typeof createFakeLocalFs>,
  commentReader?: ReturnType<typeof createFakeCommentReader>,
) {
  return createLocalFileRoutes({
    cache: createFakeLocalFilesCache(ticket),
    fs,
    ...(commentReader === undefined ? {} : { commentReader }),
  });
}

function filesUrl(id: string): string {
  return `/api/tickets/${id}/local-files`;
}

function listUrl(relativePath: string): string {
  return `${filesUrl(TICKET)}/list?path=${encodeURIComponent(relativePath)}`;
}

async function filePaths(response: Response): Promise<string[]> {
  const body = (await response.json()) as { files: { path: string }[] };
  return body.files.map((file) => file.path);
}

describe('GET /api/tickets/:id/local-files', () => {
  it('returns the seven existing refs from the synthetic description', async () => {
    const fs = createFakeLocalFs();
    fs.addFile('projects/demo/script/scenes.json', '{}');
    fs.addFile('projects/demo/script/review.md', '# r');
    fs.addFile('out/13-demo/stills/s01.png', 'png');
    fs.addFile('out/13-demo/reading-review.mp4', 'mp4mp4');
    fs.addFile('channel/uploads/13-demo/upload.md', 'u');
    fs.addFile('channel/uploads/13-demo/upload.json', '{"a":1}');
    fs.addFile('projects/demo/thumbnail.json', '{}');

    const response = await requestLocal(
      routesFor({ description: SYNTHETIC_DESCRIPTION }, fs),
      filesUrl(TICKET),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      files: [
        { path: 'projects/demo/script/scenes.json', kind: 'json', size: 2 },
        { path: 'projects/demo/script/review.md', kind: 'markdown', size: 3 },
        { path: 'out/13-demo/stills', kind: 'directory', size: null },
        { path: 'out/13-demo/reading-review.mp4', kind: 'video', size: 6 },
        { path: 'channel/uploads/13-demo/upload.md', kind: 'markdown', size: 1 },
        { path: 'channel/uploads/13-demo/upload.json', kind: 'json', size: 7 },
        { path: 'projects/demo/thumbnail.json', kind: 'json', size: 2 },
      ],
    });
  });

  it('picks paths from notes and comments after the description', async () => {
    const fs = createFakeLocalFs();
    fs.addFile('docs/a.md', 'a');
    fs.addFile('docs/b.md', 'b');
    fs.addFile('docs/c.md', 'c');

    const response = await requestLocal(
      routesFor(
        { description: 'docs/a.md', notes: 'メモ：docs/b.md' },
        fs,
        createFakeCommentReader(['見る：docs/c.md']),
      ),
      filesUrl(TICKET),
    );

    expect(response.status).toBe(200);
    expect(await filePaths(response)).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md']);
  });

  it('picks paths from description, design, acceptance criteria, then notes', async () => {
    const fs = createFakeLocalFs();
    fs.addFile('docs/a.md', 'a');
    fs.addFile('docs/d.md', 'd');
    fs.addFile('docs/ac.md', 'ac');
    fs.addFile('docs/b.md', 'b');

    const response = await requestLocal(
      createLocalFileRoutes({
        cache: createFakeLocalFilesCache({
          description: '見る：docs/a.md',
          design: '設計：docs/d.md',
          acceptanceCriteria: '受け入れ：docs/ac.md',
          notes: 'メモ：docs/b.md',
        }),
        fs,
      }),
      filesUrl(TICKET),
    );

    expect(response.status).toBe(200);
    expect(await filePaths(response)).toEqual([
      'docs/a.md',
      'docs/d.md',
      'docs/ac.md',
      'docs/b.md',
    ]);
  });

  it('keeps description and notes when the comment reader rejects', async () => {
    const fs = createFakeLocalFs();
    fs.addFile('docs/a.md', 'a');
    fs.addFile('docs/b.md', 'b');

    const response = await requestLocal(
      routesFor(
        { description: 'docs/a.md', notes: 'メモ：docs/b.md' },
        fs,
        createFakeCommentReader(new Error('comments down')),
      ),
      filesUrl(TICKET),
    );

    expect(response.status).toBe(200);
    expect(await filePaths(response)).toEqual(['docs/a.md', 'docs/b.md']);
  });

  it('rejects an unsafe ticket id and an unknown ticket', async () => {
    const app = routesFor({}, createFakeLocalFs());

    const badId = await requestLocal(app, filesUrl('bad%20id'));
    expect(badId.status).toBe(400);
    expect(await badId.json()).toEqual({ error: 'invalid ticket id' });

    const missing = await requestLocal(app, filesUrl('video-999'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: 'ticket not found',
      id: 'video-999',
    });
  });
});

describe('GET /api/tickets/:id/local-files/list', () => {
  it('lists allowed names in natural order, including a trailing slash', async () => {
    const fs = createFakeLocalFs();
    fs.addFile('out/13-demo/stills/s1.png', 's1');
    fs.addFile('out/13-demo/stills/s2.png', 's2');
    fs.addFile('out/13-demo/stills/s10.png', 's10');
    fs.addFile('out/13-demo/stills/.hidden.png', 'no');
    fs.addFile('out/13-demo/stills/notes.ts', 'ts');
    fs.addFile('out/13-demo/stills/sub/a.png', 'a');

    const response = await requestLocal(routesFor({}, fs), listUrl('out/13-demo/stills/'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: 'out/13-demo/stills',
      entries: [
        {
          name: 's1.png',
          path: 'out/13-demo/stills/s1.png',
          kind: 'image',
          size: 2,
        },
        {
          name: 's2.png',
          path: 'out/13-demo/stills/s2.png',
          kind: 'image',
          size: 2,
        },
        {
          name: 's10.png',
          path: 'out/13-demo/stills/s10.png',
          kind: 'image',
          size: 3,
        },
        {
          name: 'sub',
          path: 'out/13-demo/stills/sub',
          kind: 'directory',
          size: null,
        },
      ],
      truncated: false,
    });
  });

  it('returns the documented list errors', async () => {
    const fs = createFakeLocalFs();
    fs.addFile('out/13-demo/stills/s1.png', 's1');
    fs.addFile('out/13-demo/stills/notes.ts', 'ts');
    const app = routesFor({}, fs);

    const missingPath = await requestLocal(app, `${filesUrl(TICKET)}/list`);
    expect(missingPath.status).toBe(400);
    expect(await missingPath.json()).toEqual({ error: 'path is required' });

    const filePath = await requestLocal(app, listUrl('out/13-demo/stills/s1.png'));
    expect(filePath.status).toBe(400);
    expect(await filePath.json()).toEqual({ error: 'not a directory' });

    const escape = await requestLocal(app, listUrl('../x'));
    expect(escape.status).toBe(400);
    expect(await escape.json()).toEqual({ error: 'invalid path' });

    const absent = await requestLocal(app, listUrl('out/missing'));
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual({ error: 'not found' });

    const unsupported = await requestLocal(app, listUrl('out/13-demo/stills/notes.ts'));
    expect(unsupported.status).toBe(415);
    expect(await unsupported.json()).toEqual({ error: 'unsupported file type' });
  });

  it('caps a directory at 500 entries and keeps natural order', async () => {
    const fs = createFakeLocalFs();
    for (let index = 0; index <= 500; index += 1) {
      fs.addFile(`big/f${index}.png`, 'x');
    }

    const response = await requestLocal(routesFor({}, fs), listUrl('big/'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      path: string;
      entries: { name: string }[];
      truncated: boolean;
    };
    expect({ path: body.path, truncated: body.truncated }).toEqual({
      path: 'big',
      truncated: true,
    });
    expect(body.entries).toHaveLength(500);
    expect(body.entries.slice(0, 3).map((entry) => entry.name)).toEqual([
      'f0.png',
      'f1.png',
      'f2.png',
    ]);
    expect(body.entries[499]?.name).toEqual('f499.png');
  });
});
