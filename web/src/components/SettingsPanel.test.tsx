import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchScanRootsConfig,
  postRefresh,
  putScanRootsConfig,
  ApiError,
  type ScanRootsConfigDto,
} from '../api';
import { SettingsPanel } from './SettingsPanel';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchScanRootsConfig: vi.fn(),
    postRefresh: vi.fn(),
    putScanRootsConfig: vi.fn(),
  };
});

const fetchScanRootsConfigMock = vi.mocked(fetchScanRootsConfig);
const postRefreshMock = vi.mocked(postRefresh);
const putScanRootsConfigMock = vi.mocked(putScanRootsConfig);
function makeConfig(overrides: Partial<ScanRootsConfigDto> = {}): ScanRootsConfigDto {
  return {
    scanRoots: ['/configured'],
    excludePaths: ['/excluded'],
    version: 'v1',
    defaultScanRoots: ['/default'],
    envOverride: false,
    envScanRoots: [],
    ...overrides,
  };
}
function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><SettingsPanel /></QueryClientProvider>);
}

describe('SettingsPanel', () => {
  beforeEach(() => {
    fetchScanRootsConfigMock.mockReset();
    postRefreshMock.mockReset();
    putScanRootsConfigMock.mockReset();
    fetchScanRootsConfigMock.mockResolvedValue(makeConfig());
    postRefreshMock.mockResolvedValue(undefined);
    putScanRootsConfigMock.mockResolvedValue({ scanRoots: ['/configured'], excludePaths: ['/excluded'], version: 'v2' });
  });
  it('shows effective roots with the user-configured badge', async () => {
    renderSettings();
    expect(await screen.findByText('/configured')).toBeInTheDocument();
    expect(screen.getByText('ユーザー設定')).toBeInTheDocument();
    expect(screen.queryByText('/default')).not.toBeInTheDocument();
  });
  it('shows default roots with the OS default badge when no user roots exist', async () => {
    fetchScanRootsConfigMock.mockResolvedValue(makeConfig({ scanRoots: [] }));
    renderSettings();
    expect(await screen.findByText('/default')).toBeInTheDocument();
    expect(screen.getByText('OS既定')).toBeInTheDocument();
  });
  it('adds a path to the local list', async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText('/configured');
    const addForm = screen.getByLabelText('パスを追加').closest('form');
    await user.type(screen.getByLabelText('パスを追加'), ' /new-path ');
    await user.click(within(addForm!).getByRole('button', { name: '追加' }));
    expect(screen.getByText('/new-path')).toBeInTheDocument();
  });
  it('shows configured exclude paths', async () => {
    renderSettings();
    await screen.findByText('/excluded');
    const excludeSection = screen.getByRole('region', { name: '除外パス' });
    expect(within(excludeSection).getByText('/excluded')).toBeInTheDocument();
  });
  it('adds, validates, and deduplicates an exclude path locally', async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText('/excluded');
    const input = screen.getByLabelText('除外パスを追加');
    const addForm = input.closest('form');

    await user.type(input, 'relative/path');
    await user.click(within(addForm!).getByRole('button', { name: '追加' }));
    expect(within(addForm!).getByText(/絶対パスを入力してください/)).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, ' /new-excluded/ ');
    await user.click(within(addForm!).getByRole('button', { name: '追加' }));
    expect(within(screen.getByRole('region', { name: '除外パス' })).getByText('/new-excluded')).toBeInTheDocument();

    await user.type(input, '/new-excluded');
    await user.click(within(addForm!).getByRole('button', { name: '追加' }));
    expect(within(screen.getByRole('region', { name: '除外パス' })).getAllByText('/new-excluded')).toHaveLength(1);
    expect(within(addForm!).getByText('既に追加されています')).toBeInTheDocument();
  });
  it('marks the exclude section as inactive when scan roots are overridden by the environment', async () => {
    fetchScanRootsConfigMock.mockResolvedValue(
      makeConfig({ envOverride: true, envScanRoots: ['/env/one'] }),
    );
    renderSettings();
    await screen.findByText('/excluded');
    const excludeSection = screen.getByRole('region', { name: '除外パス(現在は無効)' });
    expect(
      within(excludeSection).getByText(
        '環境変数 BDBOARD_SCAN_ROOTS が有効なため、保存済みの除外パスは現在スキャンに適用されません。',
      ),
    ).toBeInTheDocument();
  });
  it('disables add and delete controls while a save is in flight', async () => {
    const user = userEvent.setup();
    let resolveSave!: (value: { scanRoots: string[]; excludePaths: string[]; version: string }) => void;
    putScanRootsConfigMock.mockImplementation(
      () => new Promise((resolve) => { resolveSave = resolve; }),
    );
    renderSettings();
    await screen.findByText('/configured');
    await user.click(screen.getByRole('button', { name: 'スキャンルート /configured を削除' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByRole('button', { name: '除外パス /excluded を削除' })).toBeDisabled();
    expect(screen.getByLabelText('パスを追加')).toBeDisabled();
    expect(screen.getByLabelText('除外パスを追加')).toBeDisabled();
    for (const addButton of screen.getAllByRole('button', { name: '追加' })) {
      expect(addButton).toBeDisabled();
    }
    resolveSave({ scanRoots: [], excludePaths: ['/excluded'], version: 'v2' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '除外パス /excluded を削除' })).toBeEnabled(),
    );
  });
  it('removes an exclude path from the local list', async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText('/excluded');
    const excludeSection = screen.getByRole('region', { name: '除外パス' });
    await user.click(within(excludeSection).getByRole('button', { name: '除外パス /excluded を削除' }));
    expect(within(excludeSection).queryByText('/excluded')).not.toBeInTheDocument();
    expect(within(excludeSection).getByText('除外パスはありません')).toBeInTheDocument();
  });
  it('saves edited exclude paths while preserving scan roots', async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText('/excluded');
    const excludeSection = screen.getByRole('region', { name: '除外パス' });
    const input = within(excludeSection).getByLabelText('除外パスを追加');
    await user.type(input, ' /another-excluded ');
    await user.click(within(input.closest('form')!).getByRole('button', { name: '追加' }));

    const saveButton = screen.getByRole('button', { name: '保存' });
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);
    await waitFor(() =>
      expect(putScanRootsConfigMock).toHaveBeenCalledWith({
        scanRoots: ['/configured'],
        excludePaths: ['/excluded', '/another-excluded'],
        version: 'v1',
      }),
    );
    await waitFor(() => expect(saveButton).toBeDisabled());
  });
  it('removes a user-configured path from the local list', async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText('/configured');
    const editList = document.querySelector<HTMLElement>('.settings-panel-edit-list');
    expect(editList).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'スキャンルート /configured を削除' }));
    expect(within(editList!).queryByText('/configured')).not.toBeInTheDocument();
  });
  it('saves local roots while preserving exclude paths', async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText('/configured');
    await user.type(screen.getByLabelText('パスを追加'), '/new-path');
    await user.click(
      within(screen.getByLabelText('パスを追加').closest('form')!).getByRole('button', { name: '追加' }),
    );
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(putScanRootsConfigMock).toHaveBeenCalledWith({
        scanRoots: ['/configured', '/new-path'],
        excludePaths: ['/excluded'],
        version: 'v1',
      }),
    );
  });
  it('shows rejected scan roots from a 400 response, truncated with one path per element', async () => {
    const user = userEvent.setup();
    putScanRootsConfigMock.mockRejectedValue(
      new ApiError(400, 'dangerous scan root rejected', {
        errorMessage: 'dangerous scan root rejected',
        details: { rejected: ['/etc', '/usr', '/var', '/bin', '/sbin', '/tmp'] },
      }),
    );
    renderSettings();
    await screen.findByText('/configured');
    await user.click(screen.getByRole('button', { name: 'スキャンルート /configured を削除' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('危険なスキャンルートのため拒否されました');
    expect(within(alert).getByText('/etc')).toBeInTheDocument();
    expect(within(alert).getByText('/usr')).toBeInTheDocument();
    expect(within(alert).getByText('/var')).toBeInTheDocument();
    expect(within(alert).getByText('/bin')).toBeInTheDocument();
    expect(within(alert).getByText('/sbin')).toBeInTheDocument();
    expect(within(alert).queryByText('/tmp')).not.toBeInTheDocument();
    expect(alert).toHaveTextContent('他 1 件');
  });

  it('shows a conflict message and refetches after a 409 save failure', async () => {
    const user = userEvent.setup();
    putScanRootsConfigMock.mockRejectedValue(
      new ApiError(409, 'scan roots config changed since read', {
        errorMessage: 'scan roots config changed since read',
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPanel />
      </QueryClientProvider>,
    );
    await screen.findByText('/configured');
    await user.click(screen.getByRole('button', { name: 'スキャンルート /configured を削除' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    // S2: the 409 message must say plainly that the unsaved edit was discarded, not just that
    // "something conflicted" — the row the user just removed reappears because dirty is cleared
    // and the view resyncs to the server's (still-current) config on the refetch below.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '他のセッションが先に変更したため保存できませんでした。入力内容は最新の設定で置き換えられました。内容を確認してからやり直してください。',
    );
    await waitFor(() => expect(fetchScanRootsConfigMock).toHaveBeenCalledTimes(2));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['scan-roots-config'] });
    await waitFor(() => {
      const editList = document.querySelector<HTMLElement>('.settings-panel-scan-root-list');
      expect(editList).not.toBeNull();
      expect(within(editList!).getByText('/configured')).toBeInTheDocument();
    });
  });
  it('falls back to a generic Japanese message when details is missing or empty (S5/N2)', async () => {
    const user = userEvent.setup();
    putScanRootsConfigMock.mockRejectedValue(
      new ApiError(400, 'dangerous scan root rejected', {
        errorMessage: 'dangerous scan root rejected',
      }),
    );
    renderSettings();
    await screen.findByText('/configured');
    await user.click(screen.getByRole('button', { name: 'スキャンルート /configured を削除' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('危険なスキャンルートが含まれているため保存できませんでした');
    expect(screen.queryByText('dangerous scan root rejected')).not.toBeInTheDocument();
  });
  it('flags a dangerous scan root row independently of unrelated edits, and clears it on removal (S1)', async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText('/configured');
    const input = screen.getByLabelText('パスを追加');
    const addForm = input.closest('form')!;
    const addButton = within(addForm).getByRole('button', { name: '追加' });

    await user.type(input, '/');
    await user.click(addButton);
    expect(
      within(screen.getByText('/').closest('li')!).getByRole('alert'),
    ).toHaveTextContent('このパスは保存時にサーバーに拒否されます');

    // Adding another (safe) path must not clear or duplicate the existing row's warning,
    // and the newly added safe path must show no warning of its own (S3).
    await user.type(input, '/Users/you/projects');
    await user.click(addButton);
    expect(
      within(screen.getByText('/').closest('li')!).getByRole('alert'),
    ).toHaveTextContent('このパスは保存時にサーバーに拒否されます');
    expect(
      within(screen.getByText('/Users/you/projects').closest('li')!).queryByRole('alert'),
    ).not.toBeInTheDocument();

    // Removing the dangerous row clears its warning along with the row itself.
    await user.click(screen.getByRole('button', { name: 'スキャンルート / を削除' }));
    expect(screen.queryByText('このパスは保存時にサーバーに拒否されます')).not.toBeInTheDocument();
  });
  it('shows a warning when scan roots are overridden by the environment', async () => {
    fetchScanRootsConfigMock.mockResolvedValue(
      makeConfig({
        envOverride: true,
        envScanRoots: ['/env/one', '/env/two'],
        scanRoots: ['/configured'],
        defaultScanRoots: ['/default'],
      }),
    );
    renderSettings();
    expect(await screen.findByText('環境変数 BDBOARD_SCAN_ROOTS が設定されているため、この画面での設定は現在無視されています')).toBeInTheDocument();
    expect(screen.getByText('/env/one')).toBeInTheDocument();
    expect(screen.getByText('/env/two')).toBeInTheDocument();
    expect(screen.getByText('環境変数')).toBeInTheDocument();
    const effectiveSection = screen.getByRole('region', { name: '現在有効なスキャンルート' });
    expect(within(effectiveSection).queryByText('/configured')).not.toBeInTheDocument();
    expect(within(effectiveSection).queryByText('/default')).not.toBeInTheDocument();
    expect(screen.getByText('保存済み設定(現在は無効)')).toBeInTheDocument();
  });
  it('rejects relative and home-relative paths and accepts Unix and Windows absolute paths', async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText('/configured');
    const input = screen.getByLabelText('パスを追加');
    const addButton = within(input.closest('form')!).getByRole('button', { name: '追加' });

    await user.type(input, 'relative/path');
    await user.click(addButton);
    expect(screen.queryByText('relative/path')).not.toBeInTheDocument();
    expect(screen.getByText(/絶対パスを入力してください/)).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '~/projects');
    await user.click(addButton);
    expect(screen.queryByText('~/projects')).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '/Users/you/projects');
    await user.click(addButton);
    expect(screen.getByText('/Users/you/projects')).toBeInTheDocument();
    expect(screen.queryByText(/絶対パスを入力してください/)).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, 'C:/Users/you/projects');
    await user.click(addButton);
    expect(screen.getByText('C:/Users/you/projects')).toBeInTheDocument();

    await user.type(input, '/Users/you/projects');
    await user.click(addButton);
    expect(screen.getByText('既に追加されています')).toBeInTheDocument();
  });
  it('disables save until edited and disables it again after a successful save', async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText('/configured');
    const saveButton = screen.getByRole('button', { name: '保存' });
    expect(saveButton).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'スキャンルート /configured を削除' }));
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);
    await waitFor(() => expect(putScanRootsConfigMock).toHaveBeenCalled());
    await waitFor(() => expect(saveButton).toBeDisabled());
  });
  it('refreshes the board and invalidates projects after saving', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPanel />
      </QueryClientProvider>,
    );
    await screen.findByText('/configured');
    await user.click(screen.getByRole('button', { name: 'スキャンルート /configured を削除' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(postRefreshMock).toHaveBeenCalledOnce());
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });
});
