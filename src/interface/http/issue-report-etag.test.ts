import { describe, expect, it } from 'vitest';
import { canonicalJson, detailEtagOf, listEtagOf, type IssueDraftDetailBody } from './issue-report-etag.js';
import type { IssueDraftDetailDto } from './issue-report-dto.js';

/** bdboard-mqoa: ETag の元になる正規化 JSON と、本文から ETag を作る関数。 */

describe('canonicalJson', () => {
  it('gives the same string whatever the key order, at every depth', () => {
    const a = { id: 'x', localOnly: { b: 1, a: [{ y: 2, x: 1 }] }, title: 't' };
    const b = { title: 't', localOnly: { a: [{ x: 1, y: 2 }], b: 1 }, id: 'x' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"id":"x","localOnly":{"a":[{"x":1,"y":2}],"b":1},"title":"t"}');
  });

  it('treats an undefined field as absent, like JSON.stringify, but keeps null and the order of arrays', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson([undefined])).toBe('[null]');
  });

  it('escapes strings, so a value cannot pass for a key', () => {
    expect(canonicalJson({ a: '","b":"1' })).not.toBe(canonicalJson({ a: '', b: '1' }));
  });
});

describe('detailEtagOf and listEtagOf', () => {
  const draft = { id: '1758812345001-0000000000000001', title: 't', restricted: false } as unknown as IssueDraftDetailDto;
  const body: IssueDraftDetailBody = { draft, images: [], latestHarnessVersion: '0.50.0' };

  it('is a strong ETag that follows every part of the body', () => {
    const etag = detailEtagOf(body);
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(detailEtagOf({ ...body, draft: { ...draft } })).toBe(etag);
    expect(detailEtagOf({ ...body, draft: { ...draft, title: 'u' } })).not.toBe(etag);
    expect(detailEtagOf({ ...body, latestHarnessVersion: null })).not.toBe(etag);
    const image = { fileName: 'a.png', url: '/a.png', byteLength: 8, createdAt: '2026-10-04T12:00:00.000Z' };
    expect(detailEtagOf({ ...body, images: [image] })).not.toBe(etag);
  });

  it('follows the order of the drafts and the pending count in the list', () => {
    const one = { id: 'a', kind: 'A', fingerprint: 'A:a', title: 'a', status: 'pending', occurrenceCount: 1, firstOccurredAt: 't', lastOccurredAt: 't', occurredProjectCount: 0 } as const;
    const two = { ...one, id: 'b', title: 'b' };
    const etag = listEtagOf({ drafts: [one, two], pendingCount: 2 });
    expect(listEtagOf({ drafts: [one, two], pendingCount: 2 })).toBe(etag);
    expect(listEtagOf({ drafts: [two, one], pendingCount: 2 })).not.toBe(etag);
    expect(listEtagOf({ drafts: [one, two], pendingCount: 1 })).not.toBe(etag);
  });
});
