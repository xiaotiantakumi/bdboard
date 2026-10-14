import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api';
import { CROSS_SITE_HELP, NETWORK_FETCH_HELP, RATE_LIMITED_HELP, TUNNEL_WRITE_HELP } from '../../writeAccessMessage';
import {
  DRAFT_CHANGED_ELSEWHERE_HELP,
  DRAFT_NOT_FOUND_HELP,
  DRAFT_TOO_LARGE_HELP,
  MANUAL_BAD_REQUEST_HELP,
  MANUAL_ENDPOINT_MISSING_HELP,
  MANUAL_LOCAL_ONLY_HELP,
  MANUAL_RATE_LIMITED_HELP,
  MANUAL_REQUEST_TOO_LARGE_HELP,
  REQUEST_TOO_LARGE_HELP,
  STORAGE_FULL_HELP,
  describeIssueDraftDismissError,
  describeIssueDraftEditError,
  describeIssueDraftManualError,
  describeIssueDraftImageError,
  IMAGE_LIMIT_REACHED_HELP,
  IMAGE_LOCAL_ONLY_HELP,
  IMAGE_REJECTED_HELP,
  IMAGE_TOO_LARGE_HELP,
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
    expect(describeIssueDraftEditError(apiError(400, { error: 'invalid request body' }))).toBe(
      '題名は 1 行で、改行・タブなどの制御文字や見えない書式文字を含めないでください。',
    );
  });

  // bdboard-pvff: 見える文字が無い題名・本文は、400 ではなく自動生成へ戻る (bdboard-ov0t)。400 になるのは、見える文字があるのに
  // 改行・制御文字・見えない書式文字を含む題名だけなので、「見える文字を含めてください」とは言わない。
  it('does not ask for visible characters on a 400 of an edit (an empty title resets to the generated text)', () => {
    expect(describeIssueDraftEditError(apiError(400, { error: 'invalid request body' }))).not.toContain('見える文字');
  });

  it('reuses the tunnel write help for a 403', () => {
    expect(describeIssueDraftEditError(apiError(403, { error: 'local access only' }))).toBe(TUNNEL_WRITE_HELP);
  });

  // bdboard-mqoa: If-Match が合わない (読んだあとにほかの場所で変わった)。最新を読み直したことと入力が残ることを伝える。
  it('explains a 412 as a change somewhere else, that the latest was reloaded, and that the input is kept', () => {
    const message = describeIssueDraftEditError(apiError(412, { error: 'draft was changed since it was read', code: 'precondition-failed' }));
    expect(message).toBe(DRAFT_CHANGED_ELSEWHERE_HELP);
    expect(message).toContain('ほかの場所で変更されました');
    expect(message).toContain('読み込み直しました');
    expect(message).toContain('入力はそのまま残しています');
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

describe('describeIssueDraftManualError (bdboard-4y8q.6.8)', () => {
  it('handles manual rate limits and local-only access before generic access messages', () => {
    expect(describeIssueDraftManualError(apiError(429, { error: 'rate limited', code: 'manual-rate-limited' }))).toBe(MANUAL_RATE_LIMITED_HELP);
    expect(describeIssueDraftManualError(apiError(429, { error: 'rate limited' }))).toBe(RATE_LIMITED_HELP);
    expect(describeIssueDraftManualError(apiError(403, { error: 'local access only' }))).toBe(MANUAL_LOCAL_ONLY_HELP);
    expect(describeIssueDraftManualError(apiError(403, { error: 'cross-site write blocked' }))).toBe(CROSS_SITE_HELP);
  });

  it('explains storage, payload validation, network errors, and unknown failures', () => {
    expect(describeIssueDraftManualError(apiError(507, { error: 'full' }))).toBe(STORAGE_FULL_HELP);
    expect(describeIssueDraftManualError(apiError(413, { error: 'large' }))).toBe(MANUAL_REQUEST_TOO_LARGE_HELP);
    expect(describeIssueDraftManualError(apiError(400, { error: 'invalid' }))).toBe(MANUAL_BAD_REQUEST_HELP);
    expect(describeIssueDraftManualError(new TypeError('Failed to fetch'))).toBe(NETWORK_FETCH_HELP);
    expect(describeIssueDraftManualError(new Error('other'))).toBe('作れませんでした。');
  });

  // 受け口の無い古いサーバー (Hono の既定の 404 は本文が JSON でない) に送ったとき、既存の下書きを指す「見つかりませんでした」を出さない。
  it('says the running server may be older than the page on a 404, not that a draft is missing', () => {
    const missingRoute = new ApiError(404, '404 Not Found', { body: '404 Not Found' });
    expect(describeIssueDraftManualError(missingRoute)).toBe(MANUAL_ENDPOINT_MISSING_HELP);
    expect(describeIssueDraftManualError(missingRoute)).not.toContain('この下書きは見つかりませんでした');
  });
});

describe('describeIssueDraftImageError', () => {
  it.each([
    ['409 image limit', apiError(409, { error: 'image limit reached', code: 'image-limit-reached' }), IMAGE_LIMIT_REACHED_HELP],
    // 理由を決めつけない (消去法で「20 枚まで」にも「未処理ではない」にもしない): code の無い 409 はステータスだけ出す。
    ['409 without a known code', apiError(409, { error: 'image limit reached' }), '付けられませんでした (HTTP 409)。'],
    ['409 with an unknown code', apiError(409, { error: 'x', code: 'something-new' }), '付けられませんでした (HTTP 409)。'],
    ['409 not pending', apiError(409, { error: 'draft is not pending', code: 'draft-not-pending', status: 'dismissed' }), '見送り'],
    ['507 storage full', apiError(507, { error: 'full', code: 'storage-full' }), STORAGE_FULL_HELP],
    ['403 local-only', apiError(403, { error: 'local access only' }), IMAGE_LOCAL_ONLY_HELP],
    ['403 CSRF', apiError(403, { error: 'cross-site write blocked' }), CROSS_SITE_HELP],
    ['400 invalid image', apiError(400, { error: 'invalid' }), IMAGE_REJECTED_HELP],
    ['413 too large', apiError(413, { error: 'too large' }), IMAGE_TOO_LARGE_HELP],
    ['404 missing', apiError(404, { error: 'missing' }), DRAFT_NOT_FOUND_HELP],
    ['network failure', new TypeError('Failed to fetch'), NETWORK_FETCH_HELP],
    ['other HTTP error', apiError(500, { error: 'internal' }), '付けられませんでした (HTTP 500)。'],
    ['non-ApiError', new Error('other'), '付けられませんでした。'],
  ])('describes %s', (_label, error, expected) => {
    expect(describeIssueDraftImageError(error)).toContain(expected);
  });
});
