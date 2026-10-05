import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  detailEtagOf,
  editDigestOf,
  ifMatchMatchesEdit,
  listEtagOf,
  type EditableDraftFields,
  type IssueDraftDetailBody,
} from './issue-report-etag.js';
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

  // toJSON を持つ値 (Date・Buffer) は、応答の本文 (JSON) では文字列などになる。素の再帰だと {} に見えて、値が変わっても ETag が変わらない。
  it('follows the value of a field that has toJSON (a Date or a Buffer), as the response body does', () => {
    const at = (iso: string) => canonicalJson({ createdAt: new Date(iso) });
    expect(at('2026-10-04T12:00:00.000Z')).toBe('{"createdAt":"2026-10-04T12:00:00.000Z"}');
    expect(at('2026-10-04T12:00:00.000Z')).not.toBe(at('2026-10-04T12:00:01.000Z'));
    expect(canonicalJson({ data: Buffer.from('a') })).not.toBe(canonicalJson({ data: Buffer.from('b') }));
    expect(canonicalJson({ nested: [{ at: new Date(0) }] })).toBe('{"nested":[{"at":"1970-01-01T00:00:00.000Z"}]}');
  });

  it('escapes strings, so a value cannot pass for a key', () => {
    expect(canonicalJson({ a: '","b":"1' })).not.toBe(canonicalJson({ a: '', b: '1' }));
  });
});

describe('detailEtagOf and listEtagOf', () => {
  const draft = { id: '1758812345001-0000000000000001', title: 't', restricted: false } as unknown as IssueDraftDetailDto;
  const body: IssueDraftDetailBody = { draft, images: [], latestHarnessVersion: '0.50.0' };

  it('is a strong ETag, "<editDigest>-<bodyDigest>", that follows every part of the body', () => {
    const etag = detailEtagOf(body);
    expect(etag).toMatch(/^"[0-9a-f]{32}-[0-9a-f]{32}"$/);
    expect(etag.startsWith(`"${editDigestOf(draft)}-`)).toBe(true);
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

  it('keeps the list ETag a single 32-hex digest of the whole body (If-None-Match only)', () => {
    expect(listEtagOf({ drafts: [], pendingCount: 0 })).toMatch(/^"[0-9a-f]{32}"$/);
  });
});

describe('editDigestOf and ifMatchMatchesEdit (bdboard-q5pj)', () => {
  const edited: EditableDraftFields = {
    id: '1758812345001-0000000000000001',
    status: 'pending',
    title: 'Mine',
    body: 'My body',
    titleEditedByUser: true,
    bodyEditedByUser: true,
  };
  const auto: EditableDraftFields = { ...edited, title: 'Auto title', body: 'Auto body', titleEditedByUser: false, bodyEditedByUser: false };
  const etagOf = (draft: EditableDraftFields) => `"${editDigestOf(draft)}-${'0'.repeat(32)}"`;

  it('is a 32-hex digest that follows the id, the status, the edited flags and the text of an edited field', () => {
    const digest = editDigestOf(edited);
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
    expect(editDigestOf({ ...edited })).toBe(digest);
    expect(editDigestOf({ ...edited, id: '1758812345002-0000000000000002' })).not.toBe(digest);
    expect(editDigestOf({ ...edited, status: 'dismissed' })).not.toBe(digest);
    expect(editDigestOf({ ...edited, title: 'Other' })).not.toBe(digest);
    expect(editDigestOf({ ...edited, body: 'Other' })).not.toBe(digest);
    expect(editDigestOf({ ...edited, titleEditedByUser: false })).not.toBe(digest);
    expect(editDigestOf({ ...edited, bodyEditedByUser: false })).not.toBe(digest);
  });

  it('leaves out the text of a field the user did not edit (it is rebuilt by every new occurrence)', () => {
    const digest = editDigestOf(auto);
    expect(editDigestOf({ ...auto, title: 'Rebuilt title', body: 'Rebuilt body' })).toBe(digest);
    // 片方だけ直した: 直した側の文は入り、直していない側の文は入らない。
    const titleOnly = { ...auto, titleEditedByUser: true, title: 'Mine' };
    expect(editDigestOf({ ...titleOnly, body: 'Rebuilt body' })).toBe(editDigestOf(titleOnly));
    expect(editDigestOf({ ...titleOnly, title: 'Other' })).not.toBe(editDigestOf(titleOnly));
  });

  it('judges If-Match by the first half of the ETag only, so the second half (the whole body) may differ', () => {
    const digest = editDigestOf(edited);
    expect(ifMatchMatchesEdit(`"${digest}-${'f'.repeat(32)}"`, edited)).toBe(true);
    expect(ifMatchMatchesEdit(`W/"${digest}-${'1'.repeat(32)}"`, edited)).toBe(true);
    expect(ifMatchMatchesEdit(`"${editDigestOf(auto)}-${'f'.repeat(32)}"`, edited)).toBe(false);
  });

  // `"<editDigest>"` だけ (前の形の ETag は 32 桁 1 つ) も、ここの形ではないので 412 になる。
  it('keeps the rules of the whole-ETag comparison: a list and * match, empty and unreadable values do not', () => {
    expect(ifMatchMatchesEdit('*', edited)).toBe(true);
    expect(ifMatchMatchesEdit(` "${'a'.repeat(32)}-${'b'.repeat(32)}" , ${etagOf(edited)} `, edited)).toBe(true);
    for (const bad of ['', ' , ', 'garbage', '"deadbeef"', `"${editDigestOf(edited)}"`, `"${editDigestOf(edited)}-"`, `"${editDigestOf(edited)}-zz"`]) {
      expect(ifMatchMatchesEdit(bad, edited)).toBe(false);
    }
  });
});
