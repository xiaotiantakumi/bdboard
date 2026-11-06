import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ProjectHarnessPackStatusDto, type ProjectHarnessStatusDto } from '../../api';
import { expectNoA11yViolations } from '../../test/axe';
import { HarnessPacksSection } from './HarnessPacksSection';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    fetchProjects: vi.fn(),
    fetchProjectHarnessStatus: vi.fn(),
    postProjectHarnessInject: vi.fn(),
  };
});

import { fetchProjectHarnessStatus, fetchProjects, postProjectHarnessInject } from '../../api';

const fetchProjectsMock = vi.mocked(fetchProjects);
const fetchStatusMock = vi.mocked(fetchProjectHarnessStatus);
const postInjectMock = vi.mocked(postProjectHarnessInject);

const PROJECT = {
  id: 'example-project',
  name: 'example-project',
  rootPath: '/tmp/example-project',
  prefixes: ['ex'],
  incompleteTicketCount: 0,
};

function pack(overrides: Partial<ProjectHarnessPackStatusDto> = {}): ProjectHarnessPackStatusDto {
  return {
    name: 'bdboard-harness',
    description: 'ベースのハーネス',
    role: 'base',
    requires: [],
    availableVersion: '1.0.0',
    installedVersion: null,
    drift: false,
    hooksState: 'none-declared',
    missingHooks: [],
    injectable: { ok: true },
    ...overrides,
  };
}

const OPTIONAL_BLOCKED = pack({
  name: 'video-pack',
  description: '動画向けパック',
  role: 'optional',
  requires: ['bdboard-harness'],
  injectable: {
    ok: false,
    code: 'requires-not-injected',
    reason: 'video-pack は bdboard-harness が未注入のため注入できません。',
  },
});

const OPTIONAL_BLOCKED_OTHER = pack({
  name: 'audio-pack',
  description: '音声向けパック',
  role: 'optional',
  requires: ['bdboard-harness'],
  injectable: {
    ok: false,
    code: 'requires-not-injected',
    reason: 'audio-pack の前提が未注入です',
  },
});

function status(packs: ProjectHarnessPackStatusDto[]): ProjectHarnessStatusDto {
  return { packs, contract: { state: 'not-applicable' } };
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HarnessPacksSection />
    </QueryClientProvider>,
  );
}

describe('HarnessPacksSection', () => {
  beforeEach(() => {
    fetchProjectsMock.mockReset();
    fetchStatusMock.mockReset();
    postInjectMock.mockReset();
    fetchProjectsMock.mockResolvedValue([PROJECT]);
  });

  it('lists name, version, description and the base/optional distinction per project', async () => {
    fetchStatusMock.mockResolvedValue(status([pack(), OPTIONAL_BLOCKED]));

    renderSection();

    expect(await screen.findByText('bdboard-harness')).toBeInTheDocument();
    expect(screen.getByText('ベースのハーネス')).toBeInTheDocument();
    expect(screen.getByText('ベース')).toBeInTheDocument();
    expect(screen.getByText('任意')).toBeInTheDocument();
    expect(screen.getByText('動画向けパック')).toBeInTheDocument();
    expect(screen.getByText('任意パック (前提: bdboard-harness)')).toBeInTheDocument();
    expect(screen.getAllByText(/未選択 \(最新 v1\.0\.0\)/)).toHaveLength(2);
  });

  it('has no a11y violations with selected, unselected and blocked packs', async () => {
    fetchStatusMock.mockResolvedValue(
      status([pack({ installedVersion: '1.0.0' }), OPTIONAL_BLOCKED]),
    );

    const { container } = renderSection();

    await screen.findByText('動画向けパック');
    await expectNoA11yViolations(container);
  });

  it('shows the server-provided reason and disables the button for a pack that cannot be selected', async () => {
    fetchStatusMock.mockResolvedValue(status([pack(), OPTIONAL_BLOCKED]));

    renderSection();

    expect(await screen.findByText(/選べません: video-pack は bdboard-harness が未注入/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'example-project に video-pack を選択して注入' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'example-project に bdboard-harness を選択して注入' }),
    ).toBeEnabled();
  });

  it('injects immediately when a selectable pack is chosen', async () => {
    const user = userEvent.setup();
    fetchStatusMock.mockResolvedValue(status([pack()]));
    postInjectMock.mockResolvedValue(status([pack({ installedVersion: '1.0.0' })]));

    renderSection();

    await user.click(
      await screen.findByRole('button', { name: 'example-project に bdboard-harness を選択して注入' }),
    );

    await waitFor(() => {
      expect(postInjectMock).toHaveBeenCalledWith('example-project', 'bdboard-harness');
    });
  });

  it('shows the 409 reason from the server instead of a generic conflict message', async () => {
    const user = userEvent.setup();
    fetchStatusMock.mockResolvedValue(status([pack()]));
    postInjectMock.mockRejectedValue(
      new ApiError(409, 'pack not injectable', {
        errorMessage: 'pack not injectable',
        code: 'requires-not-injected',
        reason: 'bdboard-harness の前提が未注入です',
      }),
    );

    renderSection();

    await user.click(
      await screen.findByRole('button', { name: 'example-project に bdboard-harness を選択して注入' }),
    );

    expect(await screen.findByText('注入できません: bdboard-harness の前提が未注入です')).toBeInTheDocument();
  });

  it('shows the selected state from the injection record and the real uninject commands, dry-run first', async () => {
    const user = userEvent.setup();
    fetchStatusMock.mockResolvedValue({
      ...status([pack({ installedVersion: '1.0.0' })]),
      bdboardRootPath: '/opt/bdboard',
    });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderSection();

    expect(await screen.findByText(/選択済み \(v1\.0\.0\)/)).toBeInTheDocument();
    // 最新で hook も揃っているので注入ボタンは出ない。
    expect(screen.queryByRole('button', { name: /に bdboard-harness を/ })).not.toBeInTheDocument();

    const row = screen.getByRole('listitem');
    await user.click(within(row).getByText('外す'));

    const dryRun =
      "node '/opt/bdboard/scripts/harness-uninject.mjs' --project '/tmp/example-project' --pack 'bdboard-harness'";
    const commands = within(row)
      .getAllByText(/harness-uninject\.mjs/)
      .map((element) => element.textContent);
    // 1 つ目が dry-run (--yes なし)、2 つ目が --yes 付き。存在しない旧スクリプト名は出さない。
    expect(commands).toEqual([dryRun, `${dryRun} --yes`]);
    expect(within(row).queryByText(/uninject-harness-pack/)).not.toBeInTheDocument();
    expect(within(row).getByText(/Claude Code の外のあなた自身の端末/)).toBeInTheDocument();
    // 絶対パスが埋まっているので置き換えの案内は出さない。
    expect(within(row).queryByText(/置き換えてください/)).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'bdboard-harness を外す前の確認コマンド (dry-run) をコピー' }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(dryRun);
    });
    await user.click(screen.getByRole('button', { name: 'bdboard-harness を外すコマンド (--yes) をコピー' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(`${dryRun} --yes`);
    });
  });

  it('keeps the <BDBOARD_ROOT> placeholder and says how to replace it when the server did not send its root', async () => {
    const user = userEvent.setup();
    fetchStatusMock.mockResolvedValue(status([pack({ installedVersion: '1.0.0' })]));

    renderSection();

    const row = await screen.findByRole('listitem');
    await user.click(within(row).getByText('外す'));
    expect(
      within(row).getByText(
        "node <BDBOARD_ROOT>/scripts/harness-uninject.mjs --project '/tmp/example-project' --pack 'bdboard-harness'",
      ),
    ).toBeInTheDocument();
    expect(within(row).getByText(/置き換えてください/)).toBeInTheDocument();
  });

  it('warns to check dependents before uninjecting a base pack, but not an optional pack', async () => {
    const user = userEvent.setup();
    const optionalInstalled = pack({
      name: 'video-pack',
      description: '動画向けパック',
      role: 'optional',
      requires: ['bdboard-harness'],
      installedVersion: '1.0.0',
    });
    fetchStatusMock.mockResolvedValue(
      status([pack({ installedVersion: '1.0.0' }), optionalInstalled]),
    );

    renderSection();

    const rows = await screen.findAllByRole('listitem');
    const [baseRow, optionalRow] = rows;
    expect(baseRow).toBeDefined();
    expect(optionalRow).toBeDefined();
    await user.click(within(baseRow as HTMLElement).getByText('外す'));
    await user.click(within(optionalRow as HTMLElement).getByText('外す'));

    expect(within(baseRow as HTMLElement).getByText(/依存していないか確認し/)).toBeInTheDocument();
    expect(within(optionalRow as HTMLElement).queryByText(/依存していないか確認し/)).not.toBeInTheDocument();
  });

  it('labels each 外す summary with its pack name and links a disabled button to its reason', async () => {
    const optionalInstalled = pack({
      name: 'video-pack',
      role: 'optional',
      requires: ['bdboard-harness'],
      installedVersion: '1.0.0',
    });
    fetchStatusMock.mockResolvedValue(
      status([pack({ installedVersion: '1.0.0' }), optionalInstalled, OPTIONAL_BLOCKED_OTHER]),
    );

    renderSection();

    expect(await screen.findByLabelText('bdboard-harness を外す手順を開く')).toHaveTextContent('外す');
    expect(screen.getByLabelText('video-pack を外す手順を開く')).toHaveTextContent('外す');

    const button = screen.getByRole('button', {
      name: 'example-project に audio-pack を選択して注入',
    });
    expect(button).toBeDisabled();
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy as string)).toHaveTextContent(
      '選べません: audio-pack の前提が未注入です',
    );
  });

  it('shows the blocked reason on a selected pack that also has drift', async () => {
    fetchStatusMock.mockResolvedValue(
      status([
        pack({
          installedVersion: '0.9.0',
          drift: true,
          injectable: {
            ok: false,
            code: 'base-has-requires',
            reason: 'bdboard-harness はベースですが requires を宣言しています',
          },
        }),
      ]),
    );

    renderSection();

    expect(await screen.findByText(/選択済み/)).toBeInTheDocument();
    // ドリフトがあるのでボタンは出るが、注入できない理由が付いて押せない。
    const button = screen.getByRole('button', { name: /に bdboard-harness を/ });
    expect(button).toBeDisabled();
    expect(
      screen.getByText('選べません: bdboard-harness はベースですが requires を宣言しています'),
    ).toBeInTheDocument();
    expect(button.getAttribute('aria-describedby')).not.toBeNull();
  });

  it('refetches the pack status after a 409 so a stale button does not stay clickable', async () => {
    const user = userEvent.setup();
    fetchStatusMock.mockResolvedValueOnce(status([pack()]));
    fetchStatusMock.mockResolvedValue(
      status([
        pack({
          injectable: { ok: false, code: 'requires-not-injected', reason: '前提が未注入です' },
        }),
      ]),
    );
    postInjectMock.mockRejectedValue(
      new ApiError(409, 'pack not injectable', {
        errorMessage: 'pack not injectable',
        code: 'requires-not-injected',
        reason: '前提が未注入です',
      }),
    );

    renderSection();

    await user.click(
      await screen.findByRole('button', { name: 'example-project に bdboard-harness を選択して注入' }),
    );

    expect(await screen.findByText('注入できません: 前提が未注入です')).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchStatusMock).toHaveBeenCalledTimes(2);
    });
    expect(
      await screen.findByRole('button', { name: 'example-project に bdboard-harness を選択して注入' }),
    ).toBeDisabled();
  });

  it('reflects a pack that disappeared from the injection record after reload', async () => {
    const user = userEvent.setup();
    fetchStatusMock.mockResolvedValueOnce(status([pack({ installedVersion: '1.0.0' })]));
    fetchStatusMock.mockResolvedValue(status([pack({ installedVersion: null })]));

    renderSection();

    expect(await screen.findByText(/選択済み/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'example-project のパック状態を再読み込み' }));
    expect(await screen.findByText(/未選択/)).toBeInTheDocument();
  });
});
