import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PlatformLimitationNotice,
  resetPlatformSupportCache,
} from './PlatformLimitationNotice';
import type { PlatformFeature, PlatformSupportDto } from '../api';

const { fetchPlatformSupport } = vi.hoisted(() => ({
  fetchPlatformSupport: vi.fn<() => Promise<PlatformSupportDto>>(),
}));

vi.mock('../api', () => ({ fetchPlatformSupport }));

const WIN32: PlatformSupportDto = {
  platform: 'win32',
  limitations: [
    {
      feature: 'session-discovery',
      reason: '稼働中のエージェントセッションの検出は Windows では利用できません。',
      detail: 'セッション検出は ps と lsof に依存している。',
    },
  ],
};

function renderNotice(feature: PlatformFeature) {
  // QueryClientProvider を張らずに描けることが、この通知をどのパネルにも
  // 落とせる条件そのもの (bdboard-70z.9)。
  return render(<PlatformLimitationNotice feature={feature} />);
}

beforeEach(() => {
  resetPlatformSupportCache();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('PlatformLimitationNotice', () => {
  it('shows the reason and the detail for a limited feature', async () => {
    fetchPlatformSupport.mockResolvedValue(WIN32);

    renderNotice('session-discovery');

    expect(
      await screen.findByText(
        '稼働中のエージェントセッションの検出は Windows では利用できません。',
      ),
    ).toBeInTheDocument();
    // 「使えません」だけでは黙って動かないのとほぼ同じなので、根拠も出す。
    expect(
      screen.getByText('セッション検出は ps と lsof に依存している。'),
    ).toBeInTheDocument();
  });

  it('renders nothing for a feature that is not limited on this platform', async () => {
    fetchPlatformSupport.mockResolvedValue(WIN32);

    const { container } = renderNotice('chat');

    await waitFor(() => {
      expect(fetchPlatformSupport).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on a fully supported platform', async () => {
    fetchPlatformSupport.mockResolvedValue({ platform: 'darwin', limitations: [] });

    const { container } = renderNotice('session-discovery');

    await waitFor(() => {
      expect(fetchPlatformSupport).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('stays out of the way when the endpoint is unavailable', async () => {
    // 制限の問い合わせに失敗したからといって、画面を壊してはいけない。
    fetchPlatformSupport.mockRejectedValue(new Error('boom'));

    const { container } = renderNotice('chat');

    await waitFor(() => {
      expect(fetchPlatformSupport).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('retries after a failed load instead of caching the failure forever', async () => {
    // 失敗をキャッシュし続けると、サーバー再起動中にたまたま初回取得が
    // 失敗しただけで、そのページの寿命の間ずっと案内が出なくなる。
    // 「正直な案内」が黙って消えるのが一番まずい。
    fetchPlatformSupport.mockRejectedValueOnce(new Error('boom'));
    fetchPlatformSupport.mockResolvedValue(WIN32);

    const first = renderNotice('session-discovery');
    await waitFor(() => {
      expect(fetchPlatformSupport).toHaveBeenCalledTimes(1);
    });
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();

    renderNotice('session-discovery');

    expect(
      await screen.findByText(
        '稼働中のエージェントセッションの検出は Windows では利用できません。',
      ),
    ).toBeInTheDocument();
    expect(fetchPlatformSupport).toHaveBeenCalledTimes(2);
  });

  it('asks the server only once even when several notices are mounted', async () => {
    // 実行プラットフォームは動かない。パネルごとに問い合わせる理由が無い。
    fetchPlatformSupport.mockResolvedValue(WIN32);

    render(
      <>
        <PlatformLimitationNotice feature="session-discovery" />
        <PlatformLimitationNotice feature="chat" />
      </>,
    );

    expect(
      await screen.findByText(
        '稼働中のエージェントセッションの検出は Windows では利用できません。',
      ),
    ).toBeInTheDocument();
    expect(fetchPlatformSupport).toHaveBeenCalledTimes(1);
  });
});
