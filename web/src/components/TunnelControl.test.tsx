import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TunnelDto } from '../api';
import { TunnelControl } from './TunnelControl';
import {
  countTunnelAccessTokenPosts,
  countTunnelDismissPosts,
  countTunnelStartPosts,
  installTunnelFetchMock,
} from '../test/tunnelFetchMock';
import { TUNNEL_NOT_RUNNING_HELP } from '../writeAccessMessage';

function renderTunnelControl() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <TunnelControl />
    </QueryClientProvider>,
  );
}

describe('TunnelControl publish confirmation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = installTunnelFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not start the tunnel when only opening the confirmation step', async () => {
    const user = userEvent.setup();
    renderTunnelControl();

    await screen.findByRole('button', { name: 'スマホ用に公開' });
    await user.click(screen.getByRole('button', { name: 'スマホ用に公開' }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(countTunnelStartPosts(fetchMock)).toBe(0);
  });

  it('starts the tunnel only after confirming publish', async () => {
    const user = userEvent.setup();
    renderTunnelControl();

    await screen.findByRole('button', { name: 'スマホ用に公開' });
    await user.click(screen.getByRole('button', { name: 'スマホ用に公開' }));
    await user.click(screen.getByRole('button', { name: '公開する' }));

    await waitFor(() => {
      expect(countTunnelStartPosts(fetchMock)).toBe(1);
    });
  });

  it('cancels confirmation without starting the tunnel', async () => {
    const user = userEvent.setup();
    renderTunnelControl();

    await screen.findByRole('button', { name: 'スマホ用に公開' });
    await user.click(screen.getByRole('button', { name: 'スマホ用に公開' }));
    await user.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(countTunnelStartPosts(fetchMock)).toBe(0);
  });

  it('dismisses confirmation on Escape without starting the tunnel', async () => {
    const user = userEvent.setup();
    renderTunnelControl();

    await screen.findByRole('button', { name: 'スマホ用に公開' });
    await user.click(screen.getByRole('button', { name: 'スマホ用に公開' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(countTunnelStartPosts(fetchMock)).toBe(0);
  });

  it('dismisses confirmation when the password input changes', async () => {
    const user = userEvent.setup();
    renderTunnelControl();

    await screen.findByRole('button', { name: 'スマホ用に公開' });
    await user.click(screen.getByRole('button', { name: 'スマホ用に公開' }));
    await user.type(
      screen.getByLabelText('トンネル用パスワード（任意）'),
      'a',
    );

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(countTunnelStartPosts(fetchMock)).toBe(0);
  });

  it('shows validation errors for too-short and too-long passwords without confirming', async () => {
    const user = userEvent.setup();
    renderTunnelControl();

    await screen.findByRole('button', { name: 'スマホ用に公開' });

    await user.type(
      screen.getByLabelText('トンネル用パスワード（任意）'),
      'a',
    );
    await user.click(screen.getByRole('button', { name: 'スマホ用に公開' }));

    expect(
      screen.getByText(
        'パスワードは2〜64文字で入力してください（トンネルURLは公開されます）',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(countTunnelStartPosts(fetchMock)).toBe(0);

    await user.clear(screen.getByLabelText('トンネル用パスワード（任意）'));
    await user.type(
      screen.getByLabelText('トンネル用パスワード（任意）'),
      'a'.repeat(65),
    );
    await user.click(screen.getByRole('button', { name: 'スマホ用に公開' }));

    expect(
      screen.getByText(
        'パスワードは2〜64文字で入力してください（トンネルURLは公開されます）',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(countTunnelStartPosts(fetchMock)).toBe(0);
  });

  it('disables publishing and explains why when Basic Auth is not enabled', async () => {
    vi.unstubAllGlobals();
    fetchMock = installTunnelFetchMock({
      state: 'off',
      available: true,
      authEnabled: false,
    });
    renderTunnelControl();

    const publish = await screen.findByRole('button', { name: 'スマホ用に公開' });
    expect(publish).toBeDisabled();
    expect(screen.getByLabelText('トンネル用パスワード（任意）')).toBeDisabled();
    expect(
      screen.getByText(/Basic Authが有効でないためトンネル公開はできません/),
    ).toBeInTheDocument();
    expect(countTunnelStartPosts(fetchMock)).toBe(0);
  });

  it('describes QR-only access without promising to display a password', async () => {
    const user = userEvent.setup();
    renderTunnelControl();

    await user.click(await screen.findByRole('button', { name: 'スマホ用に公開' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('公開後のQRコードから開きます');
    expect(dialog).not.toHaveTextContent('公開後にこの画面に表示されます');
  });
});

describe('TunnelControl QR code', () => {
  const ON_TUNNEL = {
    state: 'on',
    available: true,
    authEnabled: true,
    url: 'https://brave-lamp-47.trycloudflare.com',
    // Legacy servers returned these values. Keep them as hostile extra fields
    // to prove the QR-only UI never renders them even during a rolling upgrade.
    username: 'example-user',
    // Placeholder-shaped on purpose: a realistic-looking literal assigned to a
    // field named `password` is what GitGuardian's generic-password detector
    // fires on, fake or not.
    password: 'example-password',
    startedAt: '2026-08-15T07:00:00.000Z',
  } as const;

  const QR_TITLE = 'トンネルURL(ワンタイムトークンつき)のQRコード';

  let fetchMock: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not request an access token until QR display is requested', async () => {
    fetchMock = installTunnelFetchMock(ON_TUNNEL);
    renderTunnelControl();

    await screen.findByRole('button', { name: 'QRを表示' });
    expect(countTunnelAccessTokenPosts(fetchMock)).toBe(0);
  });

  it('hides the QR until asked, then renders it while the tunnel is on', async () => {
    const user = userEvent.setup();
    fetchMock = installTunnelFetchMock(ON_TUNNEL);
    renderTunnelControl();

    const toggle = await screen.findByRole('button', { name: 'QRを表示' });
    expect(screen.queryByTitle(QR_TITLE)).not.toBeInTheDocument();

    await user.click(toggle);

    await waitFor(() => {
      expect(countTunnelAccessTokenPosts(fetchMock)).toBe(1);
    });
    expect(screen.getByTitle(QR_TITLE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'QRを隠す' })).toBeInTheDocument();
  });

  it('does not show the access token as visible text', async () => {
    const user = userEvent.setup();
    fetchMock = installTunnelFetchMock(ON_TUNNEL);
    renderTunnelControl();

    await user.click(await screen.findByRole('button', { name: 'QRを表示' }));

    await waitFor(() => {
      expect(screen.getByTitle(QR_TITLE)).toBeInTheDocument();
    });
    expect(screen.queryByText('example-token')).toBeNull();
  });

  it('does not show tunnel URL, username, or password as visible text', async () => {
    installTunnelFetchMock(ON_TUNNEL);
    renderTunnelControl();

    await screen.findByRole('button', { name: 'QRを表示' });

    expect(screen.queryByText(ON_TUNNEL.url)).not.toBeInTheDocument();
    expect(screen.queryByText(ON_TUNNEL.username)).not.toBeInTheDocument();
    expect(screen.queryByText(ON_TUNNEL.password)).not.toBeInTheDocument();
  });

  it('shows an error message when access token issuance fails with 409', async () => {
    const user = userEvent.setup();
    fetchMock = installTunnelFetchMock(ON_TUNNEL, { accessTokenStatus: 409 });
    renderTunnelControl();

    await user.click(await screen.findByRole('button', { name: 'QRを表示' }));

    await waitFor(() => {
      expect(screen.getByText(TUNNEL_NOT_RUNNING_HELP)).toBeInTheDocument();
    });
    expect(screen.queryByTitle(QR_TITLE)).not.toBeInTheDocument();
  });

  it('requests a fresh access token each time QR display is toggled', async () => {
    const user = userEvent.setup();
    fetchMock = installTunnelFetchMock(ON_TUNNEL);
    renderTunnelControl();

    await user.click(await screen.findByRole('button', { name: 'QRを表示' }));
    await waitFor(() => {
      expect(countTunnelAccessTokenPosts(fetchMock)).toBe(1);
    });

    await user.click(screen.getByRole('button', { name: 'QRを隠す' }));
    await user.click(screen.getByRole('button', { name: 'QRを表示' }));

    await waitFor(() => {
      expect(countTunnelAccessTokenPosts(fetchMock)).toBe(2);
    });
  });

  it('does not offer or render the QR while the tunnel is off', async () => {
    installTunnelFetchMock();
    renderTunnelControl();

    await screen.findByRole('button', { name: 'スマホ用に公開' });

    expect(screen.queryByRole('button', { name: 'QRを表示' })).not.toBeInTheDocument();
    expect(screen.queryByTitle(QR_TITLE)).not.toBeInTheDocument();
  });
});

// bdboard-cu4: スマホ側で「なぜ書き込めないのか」が分からない状態だったので、
// 公開中のトンネルが読み書きできるのかをローカルの操作パネルに出す。
describe('TunnelControl write access notice', () => {
  const BASE_ON_TUNNEL = {
    state: 'on',
    available: true,
    authEnabled: true,
    url: 'https://brave-lamp-47.trycloudflare.com',
    startedAt: '2026-08-15T07:00:00.000Z',
  } as const;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('says the tunnel is read-only, and why, when writes are closed', async () => {
    installTunnelFetchMock({ ...BASE_ON_TUNNEL, writeAccess: false });
    renderTunnelControl();

    const notice = await screen.findByText(/読み取り専用です/);
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).toContain('12文字未満');
  });

  it('says writes work but only from the QR entrance when they are open', async () => {
    installTunnelFetchMock({ ...BASE_ON_TUNNEL, writeAccess: true });
    renderTunnelControl();

    const notice = await screen.findByText(/変更もできます/);
    expect(notice.textContent).toContain('公開後のQRコード');
    expect(notice.textContent).not.toContain('手入力');
    expect(screen.queryByText(/読み取り専用です。パスワードが/)).not.toBeInTheDocument();
  });

  // 古いサーバー(writeAccess を返さない)相手に、読み書きできると断定しないこと。
  it('claims nothing when the server does not report write access', async () => {
    installTunnelFetchMock(BASE_ON_TUNNEL);
    renderTunnelControl();

    await screen.findByRole('button', { name: 'QRを表示' });
    expect(screen.queryByText(/読み取り専用です/)).not.toBeInTheDocument();
    expect(screen.queryByText(/変更もできます/)).not.toBeInTheDocument();
  });

  it('warns about the 12-character rule before publishing', async () => {
    installTunnelFetchMock();
    renderTunnelControl();

    await screen.findByRole('button', { name: 'スマホ用に公開' });
    expect(
      screen.getByText(/パスワードが12文字未満だと、スマホからは読み取り専用/),
    ).toBeInTheDocument();
  });
});

describe('TunnelControl tunnel interruption notice', () => {
  const INTERRUPTED_AT = '2026-08-15T12:34:56.789Z';

  const INTERRUPTED_OFF_TUNNEL = {
    state: 'off',
    available: true,
    authEnabled: true,
    interruptedAt: INTERRUPTED_AT,
  } as const;

  let fetchMock: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the notice when interruptedAt is set and the tunnel is off', async () => {
    installTunnelFetchMock(INTERRUPTED_OFF_TUNNEL);
    renderTunnelControl();

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(
      '前回はトンネルが動作中のままサーバーが停止しました。',
    );
    expect(
      notice.querySelector('time')?.getAttribute('dateTime'),
    ).toBe(INTERRUPTED_AT);
  });

  it('does not show the notice when interruptedAt is absent', async () => {
    installTunnelFetchMock();
    renderTunnelControl();

    await screen.findByRole('button', { name: 'スマホ用に公開' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not show the notice when the tunnel is on even if interruptedAt is present', async () => {
    installTunnelFetchMock({
      state: 'on',
      available: true,
      authEnabled: true,
      url: 'https://brave-lamp-47.trycloudflare.com',
      startedAt: '2026-08-15T07:00:00.000Z',
      interruptedAt: INTERRUPTED_AT,
    });
    renderTunnelControl();

    await screen.findByRole('button', { name: 'QRを表示' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('dismisses the notice via POST /api/tunnel/interruption/dismiss', async () => {
    const user = userEvent.setup();
    fetchMock = installTunnelFetchMock(INTERRUPTED_OFF_TUNNEL);
    renderTunnelControl();

    await screen.findByRole('status');
    await user.click(screen.getByRole('button', { name: '閉じる' }));

    await waitFor(() => {
      expect(countTunnelDismissPosts(fetchMock)).toBe(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  it('does not leak URL or password values into the interruption notice', async () => {
    installTunnelFetchMock({
      state: 'off',
      available: true,
      authEnabled: true,
      interruptedAt: INTERRUPTED_AT,
      url: 'https://leaked-url.example.trycloudflare.com',
      password: 'example-leaked-password',
    } as TunnelDto & { url: string; password: string });
    renderTunnelControl();

    const notice = await screen.findByRole('status');
    const noticeText = notice.textContent ?? '';
    expect(noticeText).not.toMatch(/https?:\/\//i);
    expect(noticeText).not.toContain('example-leaked-password');
    expect(noticeText).not.toContain('leaked-url');
  });
});
