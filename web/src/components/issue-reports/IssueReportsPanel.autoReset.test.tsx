/**
 * bdboard-494n: 不具合報告の画面の流れで、'' と「直した」印のまま保存された本文を自動の文へ戻せる。
 * 保存の応答が中身の問い合わせに入り、プレビューにも自動の文が出て、ボタンは消える。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueDraftDetailDto, IssueDraftSummaryDto } from '../../api/issue-reports';
import { IssueReportsPanel } from './IssueReportsPanel';

vi.mock('../../api/issue-reports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/issue-reports')>()),
  fetchIssueDrafts: vi.fn(),
  fetchIssueDraft: vi.fn(),
  patchIssueDraft: vi.fn(),
}));
import { fetchIssueDraft, fetchIssueDrafts, patchIssueDraft } from '../../api/issue-reports';

const ID = '1758812345678-a1b2c3d4e5f6a7b8';
const summary: IssueDraftSummaryDto = {
  id: ID,
  kind: 'B',
  fingerprint: 'B:hook.sh:abcd',
  title: 'Hook failed',
  status: 'pending',
  occurrenceCount: 3,
  firstOccurredAt: '2026-10-01T00:00:00.000Z',
  lastOccurredAt: '2026-10-04T00:00:00.000Z',
  occurredProjectCount: 1,
};
const AUTO_BODY = 'Automatic body text';
/** #889 より前に '' と「直した」印で保存された本文。題名は自動のまま。 */
const legacyBody: IssueDraftDetailDto = {
  ...summary,
  body: '',
  titleEditedByUser: false,
  bodyEditedByUser: true,
  localOnly: { errorTextTruncated: false, envInfo: {} },
  occurredProjects: [],
  restricted: false,
};
const restored: IssueDraftDetailDto = { ...legacyBody, body: AUTO_BODY, bodyEditedByUser: false };

describe('IssueReportsPanel automatic text reset (bdboard-494n)', () => {
  beforeEach(() => {
    vi.mocked(fetchIssueDrafts).mockReset();
    vi.mocked(fetchIssueDraft).mockReset();
    vi.mocked(patchIssueDraft).mockReset();
    vi.mocked(fetchIssueDrafts).mockResolvedValue({ drafts: [summary], pendingCount: 1 });
  });

  it('puts back a body saved empty with the edited mark, and shows the automatic text in the editor and the preview', async () => {
    vi.mocked(fetchIssueDraft).mockResolvedValue({ draft: legacyBody, images: [], latestHarnessVersion: null });
    // 保存後の読み直しは、サーバーが持つ今の状態 (自動の文に戻った下書き) を返す。
    vi.mocked(patchIssueDraft).mockImplementation(async () => {
      vi.mocked(fetchIssueDraft).mockResolvedValue({ draft: restored, images: [], latestHarnessVersion: null });
      return { draft: restored, errorTextTrimmed: false };
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <IssueReportsPanel />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole('button', { name: /Hook failed/ }));
    await screen.findByRole('article', { name: '下書きの中身' });
    await user.click(screen.getByRole('button', { name: '直す' }));

    // 題名は直していないので、戻すボタンは本文だけ。
    expect(screen.queryByRole('button', { name: '題名を自動の文に戻す' })).toBeNull();
    expect(screen.getByRole('textbox', { name: /^本文/ })).toHaveValue('');
    await user.click(screen.getByRole('button', { name: '本文を自動の文に戻す' }));

    expect(patchIssueDraft).toHaveBeenCalledTimes(1);
    expect(patchIssueDraft).toHaveBeenCalledWith(ID, { body: '' });
    await waitFor(() => expect(screen.getByRole('textbox', { name: /^本文/ })).toHaveValue(AUTO_BODY));
    expect(screen.getByText('本文を自動の文に戻しました。')).toBeInTheDocument();
    // 「直した」印が外れた応答で中身が置き換わり、戻すボタンは消える。裏の更新の知らせも (自分で戻したぶんは) 残らない。
    await waitFor(() => expect(screen.queryByRole('button', { name: '本文を自動の文に戻す' })).toBeNull());
    await waitFor(() => expect(screen.queryByText(/裏で更新されました/)).toBeNull());

    await user.click(screen.getByRole('button', { name: 'プレビュー' }));
    expect(screen.getByText(AUTO_BODY)).toBeInTheDocument();
  });

  it('keeps the draft as it was when the reset fails, with the reason shown', async () => {
    vi.mocked(fetchIssueDraft).mockResolvedValue({ draft: legacyBody, images: [], latestHarnessVersion: null });
    vi.mocked(patchIssueDraft).mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <IssueReportsPanel />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole('button', { name: /Hook failed/ }));
    await screen.findByRole('article', { name: '下書きの中身' });
    await user.click(screen.getByRole('button', { name: '直す' }));
    await user.click(screen.getByRole('button', { name: '本文を自動の文に戻す' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存できませんでした。');
    expect(screen.getByRole('textbox', { name: /^本文/ })).toHaveValue('');
    expect(screen.getByRole('button', { name: '本文を自動の文に戻す' })).toBeEnabled();
  });
});
