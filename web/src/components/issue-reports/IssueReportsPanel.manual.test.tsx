import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import type { IssueDraftDetailDto, IssueDraftSummaryDto } from '../../api/issue-reports';
import { stubObjectUrls } from '../../test/objectUrls';
import { IssueReportsPanel, type IssueReportsPanelProps } from './IssueReportsPanel';

vi.mock('../../api/issue-reports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/issue-reports')>();
  return {
    ...actual,
    fetchIssueDrafts: vi.fn(),
    fetchIssueDraft: vi.fn(),
    fetchIssueReportPendingCount: vi.fn(),
    createManualIssueDraft: vi.fn(),
    uploadIssueDraftImage: vi.fn(),
  };
});

import { createManualIssueDraft, fetchIssueDraft, fetchIssueDrafts, uploadIssueDraftImage } from '../../api/issue-reports';

const NEW_ID = '1758812345678-a1b2c3d4e5f6a7b8';

const dismissed: IssueDraftSummaryDto = {
  id: '1-0000000000000000',
  kind: 'B',
  fingerprint: 'B:hook.sh:abcd',
  title: 'Old dismissed report',
  status: 'dismissed',
  occurrenceCount: 1,
  firstOccurredAt: '2026-10-01T00:00:00.000Z',
  lastOccurredAt: '2026-10-01T00:00:00.000Z',
  occurredProjectCount: 1,
  dismissReason: 'duplicate',
};

const created: IssueDraftSummaryDto = {
  id: NEW_ID,
  kind: 'C',
  fingerprint: 'C:manual:0123456789abcdef',
  title: 'Board freezes',
  status: 'pending',
  occurrenceCount: 1,
  firstOccurredAt: '2026-10-06T00:00:00.000Z',
  lastOccurredAt: '2026-10-06T00:00:00.000Z',
  occurredProjectCount: 0,
};

const createdDetail: IssueDraftDetailDto = {
  ...created,
  body: 'Provisional body',
  titleEditedByUser: true,
  bodyEditedByUser: false,
  restricted: false,
};

function renderPanel(props: IssueReportsPanelProps) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <IssueReportsPanel {...props} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

async function writeReport(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '新しく報告' }));
  await user.type(screen.getByRole('textbox', { name: /題名/ }), 'Board freezes');
  await user.type(screen.getByRole('textbox', { name: /説明/ }), 'It freezes when I open the tab');
  await user.click(screen.getByRole('button', { name: '送る' }));
}

describe('IssueReportsPanel: 新しく報告 (bdboard-4y8q.6.8)', () => {
  beforeEach(() => {
    vi.mocked(fetchIssueDrafts).mockReset();
    vi.mocked(fetchIssueDraft).mockReset();
    vi.mocked(createManualIssueDraft).mockReset();
    vi.mocked(fetchIssueDrafts).mockResolvedValue({ drafts: [dismissed], pendingCount: 0 });
    vi.mocked(fetchIssueDraft).mockResolvedValue({ draft: createdDetail, images: [] });
    vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])('lets you open the writing screen when the page is opened on %s', async (hostname) => {
    const user = renderPanel({ hostname });
    const button = await screen.findByRole('button', { name: '新しく報告' });
    expect(button).toBeEnabled();
    expect(screen.queryByText(/ローカルで開いたときだけ書けます/)).toBeNull();
    await user.click(button);
    expect(screen.getByRole('form', { name: '新しく報告' })).toBeInTheDocument();
  });

  it.each(['board.example.com', '192.168.1.20', 'abc.trycloudflare.com'])('disables the button and says it is local-only on %s', async (hostname) => {
    const user = renderPanel({ hostname });
    const button = await screen.findByRole('button', { name: '新しく報告' });
    expect(button).toBeDisabled();
    expect(screen.getByText(/ローカルで開いたときだけ書けます/)).toBeInTheDocument();
    expect(button).toHaveAccessibleDescription(/ローカルで開いたときだけ書けます/);
    await user.click(button);
    expect(screen.queryByRole('form', { name: '新しく報告' })).toBeNull();
  });

  it('after a successful send, reloads the list, switches to the pending list and selects the new draft', async () => {
    const user = renderPanel({ hostname: 'localhost' });
    await user.click(await screen.findByRole('button', { name: /見送り/ }));
    expect(await screen.findByText('Old dismissed report')).toBeInTheDocument();
    vi.mocked(fetchIssueDrafts).mockResolvedValue({ drafts: [created, dismissed], pendingCount: 1 });
    const listCallsBefore = vi.mocked(fetchIssueDrafts).mock.calls.length;
    await writeReport(user);
    expect(await screen.findByRole('article', { name: '下書きの中身' })).toBeInTheDocument();
    expect(createManualIssueDraft).toHaveBeenCalledWith({
      title: 'Board freezes',
      description: 'It freezes when I open the tab',
    });
    expect(vi.mocked(fetchIssueDrafts).mock.calls.length).toBeGreaterThan(listCallsBefore);
    expect(fetchIssueDraft).toHaveBeenCalledWith(NEW_ID);
    expect(screen.queryByRole('form', { name: '新しく報告' })).toBeNull();
    expect(screen.getByRole('button', { name: /未処理 \(1\)/ })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByRole('button', { name: /Board freezes/ })).toHaveAttribute('aria-current', 'true');
  });

  it('sends the board project when the panel is given one, and none otherwise', async () => {
    const user = renderPanel({
      hostname: 'localhost',
      reportProject: { name: 'example-project', path: '/Users/example-user/work/example-project' },
    });
    await writeReport(user);
    await screen.findByRole('article', { name: '下書きの中身' });
    expect(createManualIssueDraft).toHaveBeenCalledWith({
      title: 'Board freezes',
      description: 'It freezes when I open the tab',
      project: { name: 'example-project', path: '/Users/example-user/work/example-project' },
    });
  });

  it('keeps the form open and shows the reason when the server answers 429', async () => {
    vi.mocked(createManualIssueDraft).mockRejectedValue(
      new ApiError(429, 'too many manual reports in the last hour', {
        errorMessage: 'too many manual reports in the last hour',
        code: 'manual-rate-limited',
      }),
    );
    const user = renderPanel({ hostname: 'localhost' });
    await writeReport(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('1 時間あたりの上限');
    expect(screen.getByRole('form', { name: '新しく報告' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /題名/ })).toHaveValue('Board freezes');
    expect(screen.queryByRole('article', { name: '下書きの中身' })).toBeNull();
  });

  it('closes the form with the cancel button, and when a draft in the list is selected', async () => {
    const user = renderPanel({ hostname: 'localhost' });
    await user.click(await screen.findByRole('button', { name: /見送り/ }));
    await user.click(await screen.findByRole('button', { name: '新しく報告' }));
    await user.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.queryByRole('form', { name: '新しく報告' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '新しく報告' }));
    expect(screen.getByRole('form', { name: '新しく報告' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Old dismissed report/ }));
    expect(screen.queryByRole('form', { name: '新しく報告' })).toBeNull();
    expect(fetchIssueDraft).toHaveBeenCalledWith(dismissed.id);
  });
});

const PRIVACY_NOTE = '画像は手元にだけ保存され、公開 issue には自動では載りません。';

describe('IssueReportsPanel: 新しく報告の画像 (bdboard-4y8q.6.9)', () => {
  let restoreObjectUrls: () => void;

  beforeEach(() => {
    vi.mocked(fetchIssueDrafts).mockReset();
    vi.mocked(fetchIssueDraft).mockReset();
    vi.mocked(createManualIssueDraft).mockReset();
    vi.mocked(uploadIssueDraftImage).mockReset();
    vi.mocked(fetchIssueDrafts).mockResolvedValue({ drafts: [created, dismissed], pendingCount: 1 });
    vi.mocked(fetchIssueDraft).mockResolvedValue({ draft: createdDetail, images: [] });
    vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
    restoreObjectUrls = stubObjectUrls().restore;
  });

  afterEach(() => {
    restoreObjectUrls();
  });

  async function openWritingScreen(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: '新しく報告' }));
  }

  function chooseImage(name: string, contents: string) {
    fireEvent.change(screen.getByLabelText('画像のファイルを選ぶ'), {
      target: { files: [new File([contents], name, { type: 'image/png' })] },
    });
  }

  it.each(['localhost', '127.0.0.1', '[::1]'])('shows the image field and the note in the writing screen on %s', async (hostname) => {
    const user = renderPanel({ hostname });
    await openWritingScreen(user);
    expect(screen.getByRole('group', { name: /画像 \(任意\)/ })).toBeInTheDocument();
    expect(screen.getByText(PRIVACY_NOTE)).toBeInTheDocument();
  });

  it.each(['board.example.com', 'abc.trycloudflare.com'])('has no image field or note anywhere when the page is opened on %s (the button is disabled)', async (hostname) => {
    const user = renderPanel({ hostname });
    const button = await screen.findByRole('button', { name: '新しく報告' });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(screen.queryByRole('group', { name: /画像/ })).toBeNull();
    expect(screen.queryByLabelText('画像のファイルを選ぶ')).toBeNull();
    expect(screen.queryByText(PRIVACY_NOTE)).toBeNull();
  });

  it('sends the images to the new draft and then selects it', async () => {
    vi.mocked(uploadIssueDraftImage).mockResolvedValue({
      image: { fileName: '1-0123456789abcdef.png', url: '/x', byteLength: 1, createdAt: '2026-10-06T00:00:00.000Z' },
    });
    const user = renderPanel({ hostname: 'localhost' });
    await openWritingScreen(user);
    chooseImage('shot.png', 'a');
    await user.type(screen.getByRole('textbox', { name: /題名/ }), 'Board freezes');
    await user.type(screen.getByRole('textbox', { name: /説明/ }), 'It freezes when I open the tab');
    await user.click(screen.getByRole('button', { name: '送る' }));
    expect(await screen.findByRole('article', { name: '下書きの中身' })).toBeInTheDocument();
    expect(uploadIssueDraftImage).toHaveBeenCalledTimes(1);
    expect(uploadIssueDraftImage).toHaveBeenCalledWith(NEW_ID, { mimeType: 'image/png', data: 'YQ==' });
    expect(fetchIssueDraft).toHaveBeenCalledWith(NEW_ID);
    expect(screen.queryByRole('form', { name: '新しく報告' })).toBeNull();
  });

  it('keeps the writing area on the result when an image does not attach, and selects the draft only when the user opens it', async () => {
    vi.mocked(uploadIssueDraftImage).mockRejectedValue(
      new ApiError(400, 'invalid or unsupported image data', { errorMessage: 'invalid or unsupported image data' }),
    );
    const user = renderPanel({ hostname: 'localhost' });
    await openWritingScreen(user);
    chooseImage('shot.png', 'a');
    await user.type(screen.getByRole('textbox', { name: /題名/ }), 'Board freezes');
    await user.type(screen.getByRole('textbox', { name: /説明/ }), 'It freezes when I open the tab');
    await user.click(screen.getByRole('button', { name: '送る' }));
    expect(await screen.findByRole('heading', { name: '下書きを作りました' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: '下書きの中身' })).toBeNull();
    expect(fetchIssueDraft).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '下書きを開く' }));
    expect(await screen.findByRole('article', { name: '下書きの中身' })).toBeInTheDocument();
    expect(fetchIssueDraft).toHaveBeenCalledWith(NEW_ID);
    expect(createManualIssueDraft).toHaveBeenCalledTimes(1);
  });
});
