import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ISSUE_DRAFT_MAX_IMAGES } from '../../domain/issue-draft.js';
import { ATTACHMENT_ALLOWED_MIME_TYPES, ATTACHMENT_MAX_BYTES, extensionForMimeType } from './attachment-validation.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const imageLimitsPath = `${REPO_ROOT}/web/src/components/issue-reports/issueDraftImageLimits.ts`;

function browserImageLimits(): Record<string, unknown> {
  const source = readFileSync(imageLimitsPath, 'utf8');
  const outputText = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  if (outputText.trim() === '') throw new Error('Browser image limit constants compiled to empty JavaScript.');
  const exports: Record<string, unknown> = {};
  // transpileModule の CommonJS 出力を単体評価し、web 側定数への import を避ける。
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
  new Function('exports', outputText)(exports);
  expect(Object.keys(exports)).toEqual(expect.arrayContaining([
    'ISSUE_DRAFT_IMAGE_MAX_COUNT', 'ISSUE_DRAFT_IMAGE_MAX_BYTES', 'ISSUE_DRAFT_IMAGE_MIME_TYPES',
  ]));
  return exports;
}

describe('browser issue report image limits', () => {
  it('matches the server image count, byte limit, and ordered MIME list', () => {
    const limits = browserImageLimits();
    expect(limits.ISSUE_DRAFT_IMAGE_MAX_COUNT).toBe(ISSUE_DRAFT_MAX_IMAGES);
    expect(limits.ISSUE_DRAFT_IMAGE_MAX_BYTES).toBe(ATTACHMENT_MAX_BYTES);
    expect(limits.ISSUE_DRAFT_IMAGE_MIME_TYPES).toEqual(ATTACHMENT_ALLOWED_MIME_TYPES);
  });

  it('maps every accepted MIME to the expected file extension', () => {
    const types = browserImageLimits().ISSUE_DRAFT_IMAGE_MIME_TYPES;
    expect(Array.isArray(types)).toBe(true);
    if (!Array.isArray(types)) throw new Error('Expected a MIME type array.');
    expect(types.map((type: string) => extensionForMimeType(type as (typeof ATTACHMENT_ALLOWED_MIME_TYPES)[number]))).toEqual(['png', 'jpg', 'webp', 'gif']);
    expect(types).toHaveLength(4);
  });
});
