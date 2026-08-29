import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAiQuotaAlertConfig,
  fetchBoardThresholdsConfig,
  fetchDbStats,
  fetchHygieneThresholdsConfig,
  fetchProjects,
  fetchScanRootsConfig,
  postRefresh,
  putAiQuotaAlertConfig,
  putBoardThresholdsConfig,
  putHygieneThresholdsConfig,
  putScanRootsConfig,
  ApiError,
  type AiQuotaAlertConfigDto,
  type BoardThresholdsConfigDto,
  type DbStatsDto,
  type HygieneThresholdsConfigDto,
  type ScanRootsConfigDto,
} from '../api';
import { expectNoA11yViolations } from '../test/axe';
import { SettingsPanel } from './SettingsPanel';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchScanRootsConfig: vi.fn(),
    fetchBoardThresholdsConfig: vi.fn(),
    fetchHygieneThresholdsConfig: vi.fn(),
    fetchDbStats: vi.fn(),
    fetchProjects: vi.fn(),
    fetchAiQuotaAlertConfig: vi.fn(),
    postRefresh: vi.fn(),
    putScanRootsConfig: vi.fn(),
    putBoardThresholdsConfig: vi.fn(),
    putHygieneThresholdsConfig: vi.fn(),
    putAiQuotaAlertConfig: vi.fn(),
  };
});

const fetchScanRootsConfigMock = vi.mocked(fetchScanRootsConfig);
const fetchBoardThresholdsConfigMock = vi.mocked(fetchBoardThresholdsConfig);
const fetchHygieneThresholdsConfigMock = vi.mocked(fetchHygieneThresholdsConfig);
const fetchDbStatsMock = vi.mocked(fetchDbStats);
const fetchProjectsMock = vi.mocked(fetchProjects);
const fetchAiQuotaAlertConfigMock = vi.mocked(fetchAiQuotaAlertConfig);
const postRefreshMock = vi.mocked(postRefresh);
const putScanRootsConfigMock = vi.mocked(putScanRootsConfig);
const putBoardThresholdsConfigMock = vi.mocked(putBoardThresholdsConfig);
const putHygieneThresholdsConfigMock = vi.mocked(putHygieneThresholdsConfig);
const putAiQuotaAlertConfigMock = vi.mocked(putAiQuotaAlertConfig);
function makeDbStats(overrides: Partial<DbStatsDto> = {}): DbStatsDto {
  return {
    sizeBytes: 12_800_000,
    tables: [
      { name: 'cfd_snapshots', rowCount: 42 },
      { name: 'projects', rowCount: 3 },
    ],
    ...overrides,
  };
}
function makeAiQuotaAlertConfig(overrides: Partial<AiQuotaAlertConfigDto> = {}): AiQuotaAlertConfigDto {
  return {
    thresholdPercent: 20,
    version: 'ai-quota-alert-v1',
    defaults: { thresholdPercent: 20 },
    ...overrides,
  };
}
function makeHygieneThresholdsConfig(
  overrides: Partial<HygieneThresholdsConfigDto> = {},
): HygieneThresholdsConfigDto {
  return {
    staleInProgressAfterMs: 7 * 24 * 60 * 60_000,
    highPriorityMax: 1,
    stalePendingDecisionAfterMs: 3 * 24 * 60 * 60_000,
    version: 'hygiene-thresholds-v1',
    defaults: {
      staleInProgressAfterMs: 7 * 24 * 60 * 60_000,
      highPriorityMax: 1,
      stalePendingDecisionAfterMs: 3 * 24 * 60 * 60_000,
    },
    ...overrides,
  };
}
function makeThresholdsConfig(overrides: Partial<BoardThresholdsConfigDto> = {}): BoardThresholdsConfigDto {
  return {
    stalledAfterMs: 86_400_000,
    livenessActiveMs: 120_000,
    livenessIdleMs: 1_800_000,
    livenessStaleMs: 86_400_000,
    inProgressWipLimit: null,
    inProgressWipLimitByProject: {},
    version: 'thresholds-v1',
    defaults: {
      stalledAfterMs: 86_400_000,
      livenessActiveMs: 120_000,
      livenessIdleMs: 1_800_000,
      livenessStaleMs: 86_400_000,
      inProgressWipLimit: null,
      inProgressWipLimitByProject: {},
    },
    ...overrides,
  };
}
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
  return {
    ...render(<QueryClientProvider client={queryClient}><SettingsPanel /></QueryClientProvider>),
    queryClient,
  };
}

describe('SettingsPanel', () => {
  beforeEach(() => {
    fetchScanRootsConfigMock.mockReset();
    fetchBoardThresholdsConfigMock.mockReset();
    fetchHygieneThresholdsConfigMock.mockReset();
    fetchDbStatsMock.mockReset();
    fetchProjectsMock.mockReset();
    fetchAiQuotaAlertConfigMock.mockReset();
    postRefreshMock.mockReset();
    putScanRootsConfigMock.mockReset();
    putBoardThresholdsConfigMock.mockReset();
    putHygieneThresholdsConfigMock.mockReset();
    putAiQuotaAlertConfigMock.mockReset();
    fetchScanRootsConfigMock.mockResolvedValue(makeConfig());
    fetchBoardThresholdsConfigMock.mockResolvedValue(makeThresholdsConfig());
    fetchHygieneThresholdsConfigMock.mockResolvedValue(makeHygieneThresholdsConfig());
    fetchDbStatsMock.mockResolvedValue(makeDbStats());
    fetchProjectsMock.mockResolvedValue([
      { id: 'proj-a', name: 'Project Alpha', rootPath: '/alpha', prefixes: [], sessionCount: 0, activeSessionCount: 0, incompleteTicketCount: 0, sessions: [] },
    ]);
    fetchAiQuotaAlertConfigMock.mockResolvedValue(makeAiQuotaAlertConfig());
    postRefreshMock.mockResolvedValue(undefined);
    putScanRootsConfigMock.mockResolvedValue({ scanRoots: ['/configured'], excludePaths: ['/excluded'], version: 'v2' });
    putBoardThresholdsConfigMock.mockResolvedValue(makeThresholdsConfig({ version: 'thresholds-v2' }));
    putHygieneThresholdsConfigMock.mockResolvedValue(
      makeHygieneThresholdsConfig({ version: 'hygiene-thresholds-v2' }),
    );
    putAiQuotaAlertConfigMock.mockResolvedValue(makeAiQuotaAlertConfig({ version: 'ai-quota-alert-v2' }));
  });
  it('has no a11y violations in the default loaded state', async () => {
    const { container } = renderSettings();

    await screen.findByText('/configured');
    await expectNoA11yViolations(container);
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

  // bdboard-chp: thresholds と WIP上限 はサーバー側で1つの設定ドキュメント =
  // 1つの version を共有している。にもかかわらず version を書き戻す effect が
  // 2つあり、それぞれ別の dirty フラグでしか止まらなかった。片方のフォームだけを
  // 編集している間にもう片方の effect が version を最新に差し替えてしまい、
  // 保存が 409 にならずに他人の変更を黙って上書きしていた。
  describe('optimistic lock version while a form is dirty (bdboard-chp)', () => {
    // 「閾値を保存」は滞留閾値と AIクォータ通知閾値の2箇所にある。セクションで絞る。
    const thresholdsSaveButton = () =>
      within(screen.getByRole('region', { name: '滞留・liveness 閾値' })).getByRole(
        'button',
        { name: '閾値を保存' },
      );

    it('keeps sending the loaded version when the thresholds form is dirty', async () => {
      const user = userEvent.setup();
      const { queryClient } = renderSettings();

      const stalledInput = await screen.findByLabelText('滞留判定 (時間)');
      await user.clear(stalledInput);
      await user.type(stalledInput, '48');

      // 別セッションが保存して version が上がり、こちらが refetch した状況。
      // 利用者はまだ編集中で、何も保存していない。
      fetchBoardThresholdsConfigMock.mockResolvedValue(
        makeThresholdsConfig({ version: 'thresholds-v2' }),
      );
      await queryClient.invalidateQueries({ queryKey: ['board-thresholds-config'] });
      await waitFor(() => {
        expect(fetchBoardThresholdsConfigMock).toHaveBeenCalledTimes(2);
      });

      await user.click(thresholdsSaveButton());

      // 読み込んだときの version を送る = サーバーが 409 を返せる。
      // v2 を送ると衝突が検出されず、相手の変更を踏み潰す。
      await waitFor(() => {
        expect(putBoardThresholdsConfigMock).toHaveBeenCalledWith(
          expect.objectContaining({ version: 'thresholds-v1' }),
        );
      });
      // onSuccess は invalidateQueries と postRefresh を await したあとに表示を
      // 出すので、PUT を観測した時点で終わるとその続きが環境の teardown 後に走る。
      // bdboard-ifff で useSaveFeedback がアンマウント後の show* を捨てるように
      // なったが、**この待ちは今も必要**: 同じ継続には setThresholdsDirty(false)
      // のような素の setState が残っていて (SettingsPanel.tsx の onSuccess)、
      // そちらは何にも守られていない。破棄済み jsdom での setState はそれ自体が
      // window is not defined を投げる。ついでに「保存が最後まで通った」の確認にも
      // なっている (PUT の観測だけでは onSuccess の完了を見ていない)。
      await screen.findByText('閾値設定を保存しました');
    });

    it('keeps sending the loaded version when the wip form is dirty', async () => {
      const user = userEvent.setup();
      const { queryClient } = renderSettings();

      const wipInput = await screen.findByLabelText('In Progress 上限 (全体)');
      await user.clear(wipInput);
      await user.type(wipInput, '5');

      fetchBoardThresholdsConfigMock.mockResolvedValue(
        makeThresholdsConfig({ version: 'thresholds-v2' }),
      );
      await queryClient.invalidateQueries({ queryKey: ['board-thresholds-config'] });
      await waitFor(() => {
        expect(fetchBoardThresholdsConfigMock).toHaveBeenCalledTimes(2);
      });

      await user.click(screen.getByRole('button', { name: 'WIP上限を保存' }));

      await waitFor(() => {
        expect(putBoardThresholdsConfigMock).toHaveBeenCalledWith(
          expect.objectContaining({ version: 'thresholds-v1' }),
        );
      });
      await screen.findByText('WIP上限を保存しました');
    });

    it('still picks up a newer version once neither form is dirty', async () => {
      const user = userEvent.setup();
      const { queryClient } = renderSettings();

      await screen.findByLabelText('滞留判定 (時間)');

      fetchBoardThresholdsConfigMock.mockResolvedValue(
        makeThresholdsConfig({ version: 'thresholds-v2' }),
      );
      await queryClient.invalidateQueries({ queryKey: ['board-thresholds-config'] });
      await waitFor(() => {
        expect(fetchBoardThresholdsConfigMock).toHaveBeenCalledTimes(2);
      });

      // どちらも未編集なら version は素直に最新へ進む。ここを止めてしまうと、
      // 「開きっぱなしのタブから保存すると必ず 409」になる。
      const stalledInput = screen.getByLabelText('滞留判定 (時間)');
      await user.clear(stalledInput);
      await user.type(stalledInput, '48');
      await user.click(thresholdsSaveButton());

      await waitFor(() => {
        expect(putBoardThresholdsConfigMock).toHaveBeenCalledWith(
          expect.objectContaining({ version: 'thresholds-v2' }),
        );
      });
      await screen.findByText('閾値設定を保存しました');
    });

    it('recovers from a 409 by retrying with the refetched version', async () => {
      const user = userEvent.setup();
      const { queryClient } = renderSettings();

      const stalledInput = await screen.findByLabelText('滞留判定 (時間)');
      await user.clear(stalledInput);
      await user.type(stalledInput, '48');

      // 別セッションが先に保存し、こちらは編集中のまま refetch した。
      fetchBoardThresholdsConfigMock.mockResolvedValue(
        makeThresholdsConfig({ version: 'thresholds-v2' }),
      );
      await queryClient.invalidateQueries({ queryKey: ['board-thresholds-config'] });
      await waitFor(() => {
        expect(fetchBoardThresholdsConfigMock).toHaveBeenCalledTimes(2);
      });

      putBoardThresholdsConfigMock.mockRejectedValueOnce(
        new ApiError(409, 'board thresholds config changed since read', {
          errorMessage: 'board thresholds config changed since read',
        }),
      );
      await user.click(thresholdsSaveButton());
      await screen.findByText(
        '他のセッションが先に変更したため保存できませんでした。入力内容は最新の設定で置き換えられました。内容を確認してからやり直してください。',
      );

      // 409 の onError は dirty をクリアして refetch する。ここで version が v2 へ
      // 前進しないと、以後の保存が永久に 409 になり画面が詰む。
      //
      // このとき refetch が返す値は直前のキャッシュと構造的に等価なので、
      // react-query の structural sharing で thresholdsQuery.data の参照は
      // 変わらない。version 更新 effect の依存配列から dirty フラグを落とすと
      // effect が再実行されず、まさにその詰みが起きる (PR#126 fable レビュー)。
      const retryInput = screen.getByLabelText('滞留判定 (時間)');
      await user.clear(retryInput);
      await user.type(retryInput, '48');
      await user.click(thresholdsSaveButton());

      await waitFor(() => {
        expect(putBoardThresholdsConfigMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ version: 'thresholds-v2' }),
        );
      });
      await screen.findByText('閾値設定を保存しました');
    });
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

  it('shows the board thresholds section with effective values', async () => {
    renderSettings();
    expect(await screen.findByRole('region', { name: '滞留・liveness 閾値' })).toBeInTheDocument();
    expect(screen.getByLabelText('滞留判定 (時間)')).toHaveValue(24);
    expect(screen.getByLabelText('liveness active (分)')).toHaveValue(2);
    expect(screen.getByLabelText('liveness idle (分)')).toHaveValue(30);
    expect(screen.getByLabelText('liveness stale (時間)')).toHaveValue(24);
  });

  it('saves edited board thresholds and refreshes the board', async () => {
    const user = userEvent.setup();
    renderSettings();
    const boardThresholdsSection = await screen.findByRole('region', { name: '滞留・liveness 閾値' });
    const saveButton = within(boardThresholdsSection).getByRole('button', { name: '閾値を保存' });
    expect(saveButton).toBeDisabled();

    await user.clear(within(boardThresholdsSection).getByLabelText('滞留判定 (時間)'));
    await user.type(within(boardThresholdsSection).getByLabelText('滞留判定 (時間)'), '12');
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);

    await waitFor(() =>
      expect(putBoardThresholdsConfigMock).toHaveBeenCalledWith({
        stalledAfterMs: 12 * 60 * 60_000,
        livenessActiveMs: 120_000,
        livenessIdleMs: 1_800_000,
        livenessStaleMs: 86_400_000,
        version: 'thresholds-v1',
      }),
    );
    await waitFor(() => expect(postRefreshMock).toHaveBeenCalled());
    expect(await screen.findByText('閾値設定を保存しました')).toBeInTheDocument();
  });

  it('shows the hygiene thresholds section with effective values', async () => {
    renderSettings();
    const section = await screen.findByRole('region', { name: '健全性 (Hygiene) 閾値' });
    expect(within(section).getByLabelText('in_progress 放置 (日)')).toHaveValue(7);
    expect(within(section).getByLabelText('高優先度上限 (P0=0)')).toHaveValue(1);
    expect(within(section).getByLabelText('確認待ち放置 (日)')).toHaveValue(3);
  });

  it('saves edited hygiene thresholds and refreshes hygiene data', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderSettings();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const section = await screen.findByRole('region', { name: '健全性 (Hygiene) 閾値' });
    const saveButton = within(section).getByRole('button', { name: '閾値を保存' });
    expect(saveButton).toBeDisabled();

    await user.clear(within(section).getByLabelText('in_progress 放置 (日)'));
    await user.type(within(section).getByLabelText('in_progress 放置 (日)'), '10');
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);

    await waitFor(() =>
      expect(putHygieneThresholdsConfigMock).toHaveBeenCalledWith({
        staleInProgressAfterMs: 10 * 24 * 60 * 60_000,
        highPriorityMax: 1,
        stalePendingDecisionAfterMs: 3 * 24 * 60 * 60_000,
        version: 'hygiene-thresholds-v1',
      }),
    );
    await waitFor(() => expect(postRefreshMock).toHaveBeenCalled());
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['hygiene'] });
    expect(await screen.findByText('健全性閾値を保存しました')).toBeInTheDocument();
  });

  it('shows server validation errors for hygiene thresholds', async () => {
    const user = userEvent.setup();
    putHygieneThresholdsConfigMock.mockRejectedValue(
      new ApiError(400, 'invalid hygiene thresholds', {
        errorMessage: 'invalid hygiene thresholds',
        details: { errors: ['高優先度上限は4以下にしてください'] },
      }),
    );
    renderSettings();
    const section = await screen.findByRole('region', { name: '健全性 (Hygiene) 閾値' });
    await user.clear(within(section).getByLabelText('高優先度上限 (P0=0)'));
    await user.type(within(section).getByLabelText('高優先度上限 (P0=0)'), '5');
    await user.click(within(section).getByRole('button', { name: '閾値を保存' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '高優先度上限は4以下にしてください',
    );
  });

  it('invalidates sessions and projects when liveness thresholds are saved', async () => {
    /*
     * bdboard-3tw.102.5: liveness 閾値はセッション系のDTOにも効くようになった。
     * postRefresh が起こすのは board.changed で、useBoardStream はそれで
     * ['sessions'] / ['projects'] を無効化しない。全エージェントが止まっている
     * 間は session.changed も飛ばないので、ここで無効化しないとヘッダーの
     * 「稼働中 N」だけが古い閾値のまま残る。
     */
    const user = userEvent.setup();
    const { queryClient } = renderSettings();
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

    const section = await screen.findByRole('region', { name: '滞留・liveness 閾値' });
    await user.clear(within(section).getByLabelText('liveness active (分)'));
    await user.type(within(section).getByLabelText('liveness active (分)'), '5');
    await user.click(within(section).getByRole('button', { name: '閾値を保存' }));

    await screen.findByText('閾値設定を保存しました');
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sessions'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });

  it('shows the wip limits section and saves edited values', async () => {
    const user = userEvent.setup();
    renderSettings();
    const wipSection = await screen.findByRole('region', { name: 'WIP上限' });
    const saveButton = within(wipSection).getByRole('button', { name: 'WIP上限を保存' });
    expect(saveButton).toBeDisabled();

    await user.type(within(wipSection).getByLabelText('In Progress 上限 (全体)'), '5');
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);

    await waitFor(() =>
      expect(putBoardThresholdsConfigMock).toHaveBeenCalledWith({
        inProgressWipLimit: 5,
        inProgressWipLimitByProject: {},
        version: 'thresholds-v1',
      }),
    );
    await waitFor(() => expect(postRefreshMock).toHaveBeenCalled());
    expect(await screen.findByText('WIP上限を保存しました')).toBeInTheDocument();
  });

  it('shows server validation errors for board thresholds', async () => {
    const user = userEvent.setup();
    putBoardThresholdsConfigMock.mockRejectedValue(
      new ApiError(400, 'invalid board thresholds', {
        errorMessage: 'invalid board thresholds',
        details: { errors: ['liveness active は liveness idle より短くしてください'] },
      }),
    );
    renderSettings();
    const boardThresholdsSection = await screen.findByRole('region', { name: '滞留・liveness 閾値' });
    await user.clear(within(boardThresholdsSection).getByLabelText('liveness active (分)'));
    await user.type(within(boardThresholdsSection).getByLabelText('liveness active (分)'), '60');
    await user.click(within(boardThresholdsSection).getByRole('button', { name: '閾値を保存' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'liveness active は liveness idle より短くしてください',
    );
  });

  it('shows the ai quota alert threshold section with effective values', async () => {
    renderSettings();
    const section = await screen.findByRole('region', { name: 'AIクォータ通知閾値' });
    expect(within(section).getByLabelText('クォータ通知閾値 (%)')).toHaveValue(20);
  });

  it('saves edited ai quota alert threshold without refreshing the board', async () => {
    const user = userEvent.setup();
    renderSettings();
    const section = await screen.findByRole('region', { name: 'AIクォータ通知閾値' });
    const saveButton = within(section).getByRole('button', { name: '閾値を保存' });
    expect(saveButton).toBeDisabled();

    await user.clear(within(section).getByLabelText('クォータ通知閾値 (%)'));
    await user.type(within(section).getByLabelText('クォータ通知閾値 (%)'), '30');
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);

    await waitFor(() =>
      expect(putAiQuotaAlertConfigMock).toHaveBeenCalledWith({
        thresholdPercent: 30,
        version: 'ai-quota-alert-v1',
      }),
    );
    expect(postRefreshMock).not.toHaveBeenCalled();
    expect(await screen.findByText('AIクォータ通知閾値を保存しました')).toBeInTheDocument();
  });

  it('shows server validation errors for ai quota alert threshold', async () => {
    const user = userEvent.setup();
    putAiQuotaAlertConfigMock.mockRejectedValue(
      new ApiError(400, 'invalid ai quota alert threshold', {
        errorMessage: 'invalid ai quota alert threshold',
        details: { errors: ['thresholdPercent は 1〜99 の整数で指定してください'] },
      }),
    );
    renderSettings();
    const section = await screen.findByRole('region', { name: 'AIクォータ通知閾値' });
    await user.clear(within(section).getByLabelText('クォータ通知閾値 (%)'));
    await user.type(within(section).getByLabelText('クォータ通知閾値 (%)'), '0');
    await user.click(within(section).getByRole('button', { name: '閾値を保存' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'thresholdPercent は 1〜99 の整数で指定してください',
    );
  });

  it('shows local db stats with formatted size and table row counts', async () => {
    renderSettings();
    const section = await screen.findByRole('region', { name: 'ローカルDB統計' });
    expect(within(section).getByText('DBサイズ: 12.2 MB')).toBeInTheDocument();
    expect(within(section).getByText('cfd_snapshots')).toBeInTheDocument();
    expect(within(section).getByText('42')).toBeInTheDocument();
    expect(within(section).getByText('projects')).toBeInTheDocument();
    expect(within(section).getByText('3')).toBeInTheDocument();
  });
});
