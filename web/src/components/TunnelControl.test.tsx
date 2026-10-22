import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
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

function renderTunnelControl(onClose: () => void = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return {
    onClose,
    ...render(
      <QueryClientProvider client={queryClient}>
        <TunnelControl open onClose={onClose} />
      </QueryClientProvider>,
    ),
  };
}

describe('TunnelControl one-click publish', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  // bdboard-y2qx: ダイアログを開くだけで、自動生成パスワードで公開が始まる。
  it('starts the tunnel once, without a password, as soon as the dialog opens', async () => {
    fetchMock = installTunnelFetchMock();
    renderTunnelControl();

    await waitFor(() => {
      expect(countTunnelStartPosts(fetchMock)).toBe(1);
    });
    const startCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/tunnel/start',
    );
    expect(String(startCall?.[1]?.body ?? '')).not.toContain('password');
    expect(
      screen.queryByRole('button', { name: 'スマホ用に公開' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('does not start when Basic Auth is not enabled, and explains why', async () => {
    fetchMock = installTunnelFetchMock({
      state: 'off',
      available: true,
      authEnabled: false,
    });
    renderTunnelControl();

    expect(
      await screen.findByText(/Basic Authが有効でないためトンネル公開はできません/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('トンネル用パスワード（任意）')).toBeDisabled();
    expect(countTunnelStartPosts(fetchMock)).toBe(0);
  });

  it('validates a custom password in the 詳細 area before starting', async () => {
    const user = userEvent.setup();
    fetchMock = installTunnelFetchMock({
      state: 'error',
      available: true,
      authEnabled: true,
      message: 'cloudflared failed',
    } as TunnelDto);
    renderTunnelControl();

    await screen.findByText('詳細');
    await user.type(screen.getByLabelText('トンネル用パスワード（任意）'), 'a');
    await user.click(screen.getByRole('button', { name: 'このパスワードで公開' }));

    expect(
      screen.getByText(
        'パスワードは2〜64文字で入力してください（トンネルURLは公開されます）',
      ),
    ).toBeInTheDocument();
    expect(countTunnelStartPosts(fetchMock)).toBe(0);

    await user.clear(screen.getByLabelText('トンネル用パスワード（任意）'));
    await user.type(
      screen.getByLabelText('トンネル用パスワード（任意）'),
      'a'.repeat(12),
    );
    await user.click(screen.getByRole('button', { name: 'このパスワードで公開' }));
    await waitFor(() => {
      expect(countTunnelStartPosts(fetchMock)).toBe(1);
    });
  });
});

describe('TunnelControl dialog chrome', () => {
  beforeEach(() => {
    installTunnelFetchMock({ state: 'off', available: true, authEnabled: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it('calls onClose when the modal close button is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderTunnelControl(onClose);

    const modal = await screen.findByRole('dialog');
    await user.click(within(modal).getByRole('button', { name: '閉じる' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the overlay is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = renderTunnelControl(onClose);

    await screen.findByRole('dialog');
    const overlay = container.querySelector('.tunnel-modal-overlay');
    expect(overlay).not.toBeNull();
    await user.click(overlay!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape is pressed', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderTunnelControl(onClose);

    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
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
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it('shows the QR right away when the tunnel is already running', async () => {
    fetchMock = installTunnelFetchMock(ON_TUNNEL);
    renderTunnelControl();

    expect(await screen.findByTitle(QR_TITLE)).toBeInTheDocument();
    expect(countTunnelAccessTokenPosts(fetchMock)).toBe(1);
    expect(countTunnelStartPosts(fetchMock)).toBe(0);
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'QRを表示' })).not.toBeInTheDocument();
  });

  it('does not show the access token, tunnel URL, username or password as visible text', async () => {
    installTunnelFetchMock(ON_TUNNEL);
    renderTunnelControl();

    await screen.findByTitle(QR_TITLE);
    expect(screen.queryByText('example-token')).toBeNull();
    expect(screen.queryByText(ON_TUNNEL.url)).not.toBeInTheDocument();
    expect(screen.queryByText(ON_TUNNEL.username)).not.toBeInTheDocument();
    expect(screen.queryByText(ON_TUNNEL.password)).not.toBeInTheDocument();
  });

  it('shows an error message when access token issuance fails with 409', async () => {
    fetchMock = installTunnelFetchMock(ON_TUNNEL, { accessTokenStatus: 409 });
    renderTunnelControl();

    await waitFor(() => {
      expect(screen.getByText(TUNNEL_NOT_RUNNING_HELP)).toBeInTheDocument();
    });
    expect(screen.queryByTitle(QR_TITLE)).not.toBeInTheDocument();
  });

  it('does not render the QR while the tunnel cannot start', async () => {
    installTunnelFetchMock({ state: 'off', available: true, authEnabled: false });
    renderTunnelControl();

    await screen.findByText(/Basic Authが有効でない/);
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
    vi.resetAllMocks();
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

    await screen.findByRole('button', { name: '停止' });
    expect(screen.queryByText(/読み取り専用です/)).not.toBeInTheDocument();
    expect(screen.queryByText(/変更もできます/)).not.toBeInTheDocument();
  });

  it('warns about the 12-character rule next to the custom password', async () => {
    installTunnelFetchMock({ state: 'off', available: true, authEnabled: false });
    renderTunnelControl();

    expect(
      await screen.findByText(/パスワードが12文字未満だと、スマホからは読み取り専用/),
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
    vi.resetAllMocks();
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

    await screen.findByText('公開を開始しています…');
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

    await screen.findByRole('button', { name: '停止' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('dismisses the notice via POST /api/tunnel/interruption/dismiss', async () => {
    const user = userEvent.setup();
    fetchMock = installTunnelFetchMock(INTERRUPTED_OFF_TUNNEL);
    renderTunnelControl();

    await screen.findByRole('status');
    const notice = screen.getByRole('status');
    await user.click(within(notice).getByRole('button', { name: '閉じる' }));

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
