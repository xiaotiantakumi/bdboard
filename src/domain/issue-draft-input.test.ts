import { describe, expect, it } from 'vitest';
import { canonicalizeReceiveInput, type ReceiveDraftInput } from './issue-draft-input.js';

describe('canonicalizeReceiveInput', () => {
  const RAW: ReceiveDraftInput = {
    kind: 'B',
    source: '  /Users/example-user/proj/.claude/hooks/stop.sh ',
    catalogSlug: '/home/example-user/.claude/failure-catalog/jq-missing',
    symptom: 'raw symptom mentioning /Users/example-user/proj stays as the caller wrote it (hand-only)',
    errorText: 'ENOENT /Users/example-user/proj/a.ts',
    envInfo: {
      bdboardVersion: '0.1.2',
      os: 'darwin',
      nodeVersion: 'v22.14.0',
      bdVersion: 'bd 1.0 (/Users/example-user/bin/bd)',
    },
    project: { name: '/Users/example-user/proj', path: '/Users/example-user/proj' },
  };

  it('folds home paths in source, catalogSlug, every envInfo string and project.name', () => {
    const out = canonicalizeReceiveInput(RAW);
    expect(out.source).toBe('~/proj/.claude/hooks/stop.sh');
    expect(out.catalogSlug).toBe('~/.claude/failure-catalog/jq-missing');
    expect(out.envInfo).toEqual({
      bdboardVersion: '0.1.2',
      os: 'darwin',
      nodeVersion: 'v22.14.0',
      bdVersion: 'bd 1.0 (~/bin/bd)',
    });
    expect(out.project?.name).toBe('~/proj');
  });

  it('leaves the hand-only fields alone: project.path, the free text and the error text', () => {
    const out = canonicalizeReceiveInput(RAW);
    expect(out.project?.path).toBe('/Users/example-user/proj');
    expect(out.symptom).toBe(RAW.symptom);
    expect(out.errorText).toBe(RAW.errorText);
  });

  it('cleans project.name: line breaks and tabs become spaces, invisible characters go, then home paths fold', () => {
    const nameOf = (name: string) => canonicalizeReceiveInput({ kind: 'B', source: 's', project: { name, path: '/p' } }).project?.name;
    expect(nameOf('/Us\u200Bers/example-user\n/proj')).toBe('~/ /proj');
    expect(nameOf(' my\nproj\u202E ')).toBe('my proj');
    // タブ・改行・BOM はパスの手前の区切りなので、取り除かず空白にして、前の語にパスを貼り付けない
    expect(nameOf('proj\t/Users/example-user/proj')).toBe('proj ~/proj');
    expect(nameOf('proj\uFEFF/Users/example-user/proj')).toBe('proj ~/proj');
  });

  it('does not add fields that were absent, does not mutate the input, and is idempotent', () => {
    const bare: ReceiveDraftInput = { kind: 'A', catalogSlug: 'slug' };
    const out = canonicalizeReceiveInput(bare);
    expect(out).toEqual(bare);
    expect(Object.keys(out)).toEqual(['kind', 'catalogSlug']);

    const before = JSON.stringify(RAW);
    const once = canonicalizeReceiveInput(RAW);
    expect(JSON.stringify(RAW)).toBe(before);
    expect(canonicalizeReceiveInput(once)).toEqual(once);
  });
});
