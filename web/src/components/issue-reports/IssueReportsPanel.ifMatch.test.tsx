/**
 * bdboard-mqoa: 画面の流れ全体で、編集の If-Match と 412 を確かめる。読んだ ETag を付けて保存 → ほかの場所で変わっていて 412 →
 * 最新を読み直して (新しい ETag と中身が届く)、入力は残り、そのまま保存し直せる。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import type { IssueDraftDetailDto, IssueDraftSummaryDto } from '../../api/issue-reports';
import { IssueReportsPanel } from './IssueReportsPanel';
import { DRAFT_CHANGED_ELSEWHERE_HELP } from './issueDraftErrors';

vi.mock('../../api/issue-reports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/issue-reports')>()),
  fetchIssueDrafts: vi.fn(),
  fetchIssueDraft: vi.fn(),
  patchIssueDraft: vi.fn(),
  fetchIssueReportPendingCount: vi.fn(),
}));
import { fetchIssueDraft, fetchIssueDrafts, patchIssueDraft } from '../../api/issue-reports';

const ID = '1758812345678-a1b2c3d4e5f6a7b8';
const summary: IssueDraftSummaryDto = {
  id: ID,
  kind: 'B',
  fingerprint: 'B:hook.sh:abcd',
  title: 'Hook failed in example-project',
  status: 'pending',
  occurrenceCount: 3,
  firstOccurredAt: '2026-10-01T00:00:00.000Z',
  lastOccurredAt: '2026-10-04T00:00:00.000Z',
  occurredProjectCount: 1,
};
const draft: IssueDraftDetailDto = {
  ...summary,
  body: 'Original body',
  titleEditedByUser: false,
  bodyEditedByUser: false,
  localOnly: { errorTextTruncated: false, envInfo: {} },
  occurredProjects: [],
  restricted: false,
};

function preconditionFailed(): ApiError {
  const payload = { error: 'draft was changed since it was read', code: 'precondition-failed' };
  return new ApiError(412, payload.error, { body: JSON.stringify(payload), errorMessage: payload.error, code: payload.code });
}

describe('IssueReportsPanel If-Match and 412 (bdboard-mqoa)', () => {
  beforeEach(() => {
    vi.mocked(fetchIssueDrafts).mockReset();
    vi.mocked(fetchIssueDraft).mockReset();
    vi.mocked(patchIssueDraft).mockReset();
    vi.mocked(fetchIssueDrafts).mockResolvedValue({ drafts: [summary], pendingCount: 1 });
  });

  async function openEditor() {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <IssueReportsPanel />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole('button', { name: /Hook failed in example-project/ }));
    await screen.findByRole('article', { name: '下書きの中身' });
    await user.click(screen.getByRole('button', { name: '直す' }));
    return user;
  }

  it('saves with the ETag it read, takes the ETag of the response for the next save', async () => {
    vi.mocked(fetchIssueDraft).mockResolvedValue({ draft, images: [], latestHarnessVersion: null, etag: '"v1"' });
    vi.mocked(patchIssueDraft).mockResolvedValue({ draft: { ...draft, title: 'First', titleEditedByUser: true }, errorTextTrimmed: false, etag: '"v2"' });
    const user = await openEditor();
    const title = screen.getByRole('textbox', { name: /^題名/ });
    await user.clear(title);
    await user.type(title, 'First');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText('保存しました。');
    expect(patchIssueDraft).toHaveBeenCalledWith(ID, { title: 'First' }, { ifMatch: '"v1"' });
  });

  it('on a 412 shows the message, reloads the latest with its new ETag, keeps the input, and the next save goes through', async () => {
    vi.mocked(fetchIssueDraft)
      .mockResolvedValueOnce({ draft, images: [], latestHarnessVersion: null, etag: '"v1"' })
      // 読み直し: ほかの場所で本文が直されていた。
      .mockResolvedValue({
        draft: { ...draft, body: 'Body edited elsewhere', bodyEditedByUser: true },
        images: [],
        latestHarnessVersion: null,
        etag: '"v9"',
      });
    vi.mocked(patchIssueDraft).mockRejectedValueOnce(preconditionFailed());
    const user = await openEditor();
    const title = screen.getByRole('textbox', { name: /^題名/ });
    await user.clear(title);
    await user.type(title, 'My new title');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(DRAFT_CHANGED_ELSEWHERE_HELP)).toBeInTheDocument();
    expect(patchIssueDraft).toHaveBeenNthCalledWith(1, ID, { title: 'My new title' }, { ifMatch: '"v1"' });
    // 最新の読み直し (中身の問い合わせの無効化) で、もう一度取りに行く。
    await waitFor(() => expect(vi.mocked(fetchIssueDraft).mock.calls.length).toBeGreaterThanOrEqual(2));
    // 入力は消えない。
    expect(screen.getByRole('textbox', { name: /^題名/ })).toHaveValue('My new title');

    vi.mocked(patchIssueDraft).mockResolvedValueOnce({
      draft: { ...draft, title: 'My new title', titleEditedByUser: true, body: 'Body edited elsewhere', bodyEditedByUser: true },
      errorTextTrimmed: false,
      etag: '"v10"',
    });
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText('保存しました。');
    // 読み直した新しい ETag で、変えた題名だけを送る。
    expect(patchIssueDraft).toHaveBeenNthCalledWith(2, ID, { title: 'My new title' }, { ifMatch: '"v9"' });
  });
});
