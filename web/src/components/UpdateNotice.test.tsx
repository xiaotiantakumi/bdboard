import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateCheckDto } from '../api';
import { UpdateNotice } from './UpdateNotice';

const fetchUpdateCheck = vi.fn<() => Promise<UpdateCheckDto>>();

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  fetchUpdateCheck: () => fetchUpdateCheck(),
}));

function renderNotice() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <UpdateNotice />
    </QueryClientProvider>,
  );
}

describe('UpdateNotice', () => {
  beforeEach(() => {
    fetchUpdateCheck.mockReset();
  });

  it('links to the release when an update is available', async () => {
    fetchUpdateCheck.mockResolvedValue({
      state: 'update-available',
      currentVersion: '1.0.0',
      latestVersion: 'v2.0.0',
      releaseUrl: 'https://github.com/xiaotiantakumi/bdboard/releases/tag/v2.0.0',
    });

    const { container } = renderNotice();

    const link = await screen.findByRole('link', {
      name: '新しいバージョン v2.0.0 が公開されています',
    });
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/xiaotiantakumi/bdboard/releases/tag/v2.0.0',
    );
    // 外部サイトを新規タブで開くリンクなので、opener を渡さない。
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(container.querySelector('.update-notice')).not.toBeNull();
  });

  it.each([
    ['up-to-date', { state: 'up-to-date', currentVersion: '1.0.0' } as UpdateCheckDto],
    ['unknown (fetch failed or disabled)', { state: 'unknown', currentVersion: '1.0.0' } as UpdateCheckDto],
  ])('renders nothing when the state is %s', async (_label, dto) => {
    // 「最新です」を常時出す価値より、ノイズを出さないことを優先する設計。
    fetchUpdateCheck.mockResolvedValue(dto);

    const { container } = renderNotice();

    await waitFor(() => {
      expect(fetchUpdateCheck).toHaveBeenCalled();
    });
    expect(container.querySelector('.update-notice')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('stays silent when the request fails', async () => {
    // ローカル完結のツールが、外部サービスの都合でエラー表示を出す理由が無い。
    fetchUpdateCheck.mockRejectedValue(new Error('offline'));

    const { container } = renderNotice();

    await waitFor(() => {
      expect(fetchUpdateCheck).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });
});
