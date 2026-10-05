import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api';
import { TUNNEL_WRITE_HELP } from '../../writeAccessMessage';
import {
  DRAFT_TOO_LARGE_HELP,
  REQUEST_TOO_LARGE_HELP,
  STORAGE_FULL_HELP,
  describeIssueDraftDismissError,
  describeIssueDraftEditError,
} from './issueDraftErrors';

function apiError(status: number, body: Record<string, unknown>): ApiError {
  return new ApiError(status, String(body.error), {
    body: JSON.stringify(body),
    errorMessage: typeof body.error === 'string' ? body.error : undefined,
    code: typeof body.code === 'string' ? body.code : undefined,
  });
}

describe('describeIssueDraftEditError (bdboard-4y8q.3.2)', () => {
  it('explains a 409 with the draft status the server returned', () => {
    const message = describeIssueDraftEditError(apiError(409, { error: 'draft is not pending', status: 'dismissed' }));
    expect(message).toContain('もう未処理ではない');
    expect(message).toContain('今の状態: 見送り');
  });

  it('tells the three kinds of 413 apart', () => {
    expect(
      describeIssueDraftEditError(
        apiError(413, { error: 'title or body is too long', code: 'too-long', maxTitleChars: 256, maxBodyChars: 65536 }),
      ),
    ).toBe('長すぎて保存できません。題名は 256 文字、本文は 65536 文字までです。');
    expect(describeIssueDraftEditError(apiError(413, { error: 'draft would exceed the size limit', code: 'draft-too-large' }))).toBe(
      DRAFT_TOO_LARGE_HELP,
    );
    expect(describeIssueDraftEditError(apiError(413, { error: 'request body too large' }))).toBe(REQUEST_TOO_LARGE_HELP);
  });

  it('explains a 507 (storage full), a 404 and a 400', () => {
    expect(describeIssueDraftEditError(apiError(507, { error: 'issue draft storage is full', code: 'storage-full' }))).toBe(
      STORAGE_FULL_HELP,
    );
    expect(describeIssueDraftEditError(apiError(404, { error: 'draft not found' }))).toContain('見つかりません');
    expect(describeIssueDraftEditError(apiError(400, { error: 'invalid request body' }))).toContain('1 行');
  });

  it('reuses the tunnel write help for a 403', () => {
    expect(describeIssueDraftEditError(apiError(403, { error: 'local access only' }))).toBe(TUNNEL_WRITE_HELP);
  });
});

describe('describeIssueDraftDismissError (bdboard-4y8q.3.2)', () => {
  it('explains a 400 reason and a 409', () => {
    expect(describeIssueDraftDismissError(apiError(400, { error: 'invalid request body' }))).toContain('200 文字以内');
    expect(describeIssueDraftDismissError(apiError(409, { error: 'draft is not pending', status: 'posted' }))).toContain(
      '今の状態: 投稿済み',
    );
  });
});
