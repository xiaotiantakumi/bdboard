import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ISSUE_DRAFT_MAX_IMAGES } from '../../domain/issue-draft.js';
import { ATTACHMENT_ALLOWED_MIME_TYPES, ATTACHMENT_MAX_BYTES, extensionForMimeType } from './attachment-validation.js';

/**
 * 「新しく報告」の画像の欄が先に検査する値 (枚数・1 枚の大きさ・形式) と、サーバーが受ける値を同じに保つ (bdboard-4y8q.6.9)。
 *
 * web/ から src/ は import できない (web-no-server-src)・src/ から web/ も import できない (server-no-web) ので、画面側は
 * web/src/components/issue-reports/issueDraftImageLimits.ts に値を二重定義している。ここでその 1 ファイルを読み、
 * TypeScript で JS にして評価し、サーバーの定数と突き合わせる。ファイルは何も import しないので、単体で評価できる。
 */
const LIMITS_FILE = fileURLToPath(
  new URL('../../../web/src/components/issue-reports/issueDraftImageLimits.ts', import.meta.url),
);

interface BrowserImageLimits {
  readonly ISSUE_DRAFT_IMAGE_MAX_COUNT: number;
  readonly ISSUE_DRAFT_IMAGE_MAX_BYTES: number;
  readonly ISSUE_DRAFT_IMAGE_MIME_TYPES: readonly string[];
}

function loadBrowserImageLimits(): BrowserImageLimits {
  const source = readFileSync(LIMITS_FILE, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exported: Record<string, unknown> = {};
  // CommonJS の出力は exports へ書くだけ (import が無いので、他に何も要らない)。
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
  new Function('exports', outputText)(exported);
  return exported as unknown as BrowserImageLimits;
}

describe('image limits of the new-report screen vs the server (bdboard-4y8q.6.9)', () => {
  const browser = loadBrowserImageLimits();

  it('exports the three values the screen checks with', () => {
    expect(Object.keys(browser).sort()).toEqual([
      'ISSUE_DRAFT_IMAGE_MAX_BYTES',
      'ISSUE_DRAFT_IMAGE_MAX_COUNT',
      'ISSUE_DRAFT_IMAGE_MIME_TYPES',
    ]);
  });

  it('allows the same number of images per draft as the server (20)', () => {
    expect(browser.ISSUE_DRAFT_IMAGE_MAX_COUNT).toBe(ISSUE_DRAFT_MAX_IMAGES);
    expect(ISSUE_DRAFT_MAX_IMAGES).toBe(20);
  });

  it('allows the same bytes per image as the server (10 MiB)', () => {
    expect(browser.ISSUE_DRAFT_IMAGE_MAX_BYTES).toBe(ATTACHMENT_MAX_BYTES);
    expect(ATTACHMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it('accepts the same formats as the server, in the same order', () => {
    expect(browser.ISSUE_DRAFT_IMAGE_MIME_TYPES).toEqual([...ATTACHMENT_ALLOWED_MIME_TYPES]);
  });

  it('only offers formats the server can store (each has a file extension)', () => {
    const extensions = browser.ISSUE_DRAFT_IMAGE_MIME_TYPES.map((type) =>
      extensionForMimeType(type as (typeof ATTACHMENT_ALLOWED_MIME_TYPES)[number]),
    );
    expect(extensions).toEqual(['png', 'jpg', 'webp', 'gif']);
  });
});
