import { describe, expect, it } from 'vitest';
import { findLocalFileRefs, type LocalFileRef } from './find-local-file-refs.js';

const SYNTHETIC_BODY = [
  '- 台本：projects/demo/script/scenes.json（レビュー表：script/review.md）',
  '- 静止画 12 枚：out/13-demo/stills/（s01〜s29・outro）',
  '- 耳確認用の動画：out/13-demo/reading-review.mp4（疑い 15 件）',
  '- 概要欄：channel/uploads/13-demo/upload.md（upload.json。youtube:check は …）',
  '- サムネ案：projects/demo/thumbnail.json',
  "直し方の案：npm run narration -- --project demo --budget '0.05'。readings.json で直せない語は …",
].join('\n');

function ref(path: string, kind: LocalFileRef['kind'], size: number | null): LocalFileRef {
  return { path, kind, size };
}

const SCENES = ref('projects/demo/script/scenes.json', 'json', 10);
const REVIEW = ref('projects/demo/script/review.md', 'markdown', 20);
const STILLS = ref('out/13-demo/stills', 'directory', null);
const READING = ref('out/13-demo/reading-review.mp4', 'video', 30);
const UPLOAD_MD = ref('channel/uploads/13-demo/upload.md', 'markdown', 40);
const UPLOAD_JSON = ref('channel/uploads/13-demo/upload.json', 'json', 50);
const THUMBNAIL = ref('projects/demo/thumbnail.json', 'json', 60);

const KNOWN = new Map<string, LocalFileRef>([
  [SCENES.path, SCENES],
  [REVIEW.path, REVIEW],
  [STILLS.path, STILLS],
  [READING.path, READING],
  [UPLOAD_MD.path, UPLOAD_MD],
  [UPLOAD_JSON.path, UPLOAD_JSON],
  [THUMBNAIL.path, THUMBNAIL],
]);

function recordingProbe(known: ReadonlyMap<string, LocalFileRef>): {
  readonly calls: string[];
  readonly probe: (relativePath: string) => Promise<LocalFileRef | undefined>;
} {
  const calls: string[] = [];
  return {
    calls,
    probe: (relativePath) => {
      calls.push(relativePath);
      return Promise.resolve(known.get(relativePath));
    },
  };
}

describe('findLocalFileRefs', () => {
  it('resolves the synthetic body in first-seen order', async () => {
    const { calls, probe } = recordingProbe(KNOWN);
    const result = await findLocalFileRefs([SYNTHETIC_BODY], probe);
    expect(result).toEqual([SCENES, REVIEW, STILLS, READING, UPLOAD_MD, UPLOAD_JSON, THUMBNAIL]);
    const nearer = calls.indexOf('projects/demo/script/script/review.md');
    const adopted = calls.indexOf('projects/demo/script/review.md');
    expect(nearer).toBeGreaterThanOrEqual(0);
    expect(nearer).toBeLessThan(adopted);
    expect(result.map((item) => item.path)).not.toContain('readings.json');
  });

  it('keeps one ref when the same path appears on another line', async () => {
    const { probe } = recordingProbe(KNOWN);
    const text = 'projects/demo/thumbnail.json\nprojects/demo/thumbnail.json';
    await expect(findLocalFileRefs([text], probe)).resolves.toEqual([THUMBNAIL]);
  });

  it('stops at the limit and does not probe later files', async () => {
    const { calls, probe } = recordingProbe(KNOWN);
    await expect(findLocalFileRefs([SYNTHETIC_BODY], probe, 2)).resolves.toEqual([SCENES, REVIEW]);
    expect(calls).toEqual([
      'projects/demo/script/scenes.json',
      'script/review.md',
      'projects/demo/script/script/review.md',
      'projects/demo/script/review.md',
    ]);
  });

  it('does not carry a resolved path onto the next line', async () => {
    const docsB = ref('docs/b.md', 'markdown', 2);
    const onlyDocsB = recordingProbe(new Map<string, LocalFileRef>([[docsB.path, docsB]]));
    await expect(findLocalFileRefs(['docs/a.md\nb.md'], onlyDocsB.probe)).resolves.toEqual([]);

    const docsA = ref('docs/a.md', 'markdown', 1);
    const resolvedOnLine1 = recordingProbe(
      new Map<string, LocalFileRef>([
        [docsA.path, docsA],
        [docsB.path, docsB],
      ]),
    );
    await expect(findLocalFileRefs(['docs/a.md\nb.md'], resolvedOnLine1.probe)).resolves.toEqual([
      docsA,
    ]);
    expect(resolvedOnLine1.calls).not.toContain('docs/b.md');
  });

  it('carries a resolved path to a later name on the same line', async () => {
    const docsA = ref('docs/a.md', 'markdown', 1);
    const docsB = ref('docs/b.md', 'markdown', 2);
    const { probe } = recordingProbe(
      new Map<string, LocalFileRef>([
        [docsA.path, docsA],
        [docsB.path, docsB],
      ]),
    );
    await expect(findLocalFileRefs(['docs/a.md（b.md）'], probe)).resolves.toEqual([docsA, docsB]);
  });

  it('orders refs across texts in the order the texts were given', async () => {
    const { probe } = recordingProbe(KNOWN);
    await expect(
      findLocalFileRefs(['projects/demo/thumbnail.json', 'projects/demo/script/scenes.json'], probe),
    ).resolves.toEqual([THUMBNAIL, SCENES]);
  });
});
