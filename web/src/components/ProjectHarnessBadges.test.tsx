import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { TUNNEL_WRITE_HELP } from '../writeAccessMessage';
import { ProjectHarnessBadges } from './ProjectHarnessBadges';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchProjectHarnessStatus: vi.fn(),
    postProjectHarnessInject: vi.fn(),
  };
});

import {
  fetchProjectHarnessStatus,
  postProjectHarnessInject,
} from '../api';

const fetchProjectHarnessStatusMock = vi.mocked(fetchProjectHarnessStatus);
const postProjectHarnessInjectMock = vi.mocked(postProjectHarnessInject);

function renderBadges(projectId = '/tmp/example-project') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProjectHarnessBadges projectId={projectId} />
    </QueryClientProvider>,
  );

  return { ...view, queryClient };
}

describe('ProjectHarnessBadges', () => {
  beforeEach(() => {
    fetchProjectHarnessStatusMock.mockReset();
    postProjectHarnessInjectMock.mockReset();
  });

  it('shows 未導入 label and inject button for missing pack', async () => {
    fetchProjectHarnessStatusMock.mockResolvedValue({
      packs: [
        {
          name: 'bdboard-harness',
          availableVersion: '0.2.0',
          installedVersion: null,
          drift: false,
        },
      ],
    });

    renderBadges();

    expect(await screen.findByText('未導入')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '注入' })).toBeInTheDocument();
  });

  it('shows drift label and update button for outdated pack', async () => {
    fetchProjectHarnessStatusMock.mockResolvedValue({
      packs: [
        {
          name: 'bdboard-harness',
          availableVersion: '0.2.0',
          installedVersion: '0.1.0',
          drift: true,
        },
      ],
    });

    renderBadges();

    expect(await screen.findByText('要更新 (0.1.0→0.2.0)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更新' })).toBeInTheDocument();
  });

  it('shows installed version without action button when up to date', async () => {
    fetchProjectHarnessStatusMock.mockResolvedValue({
      packs: [
        {
          name: 'bdboard-harness',
          availableVersion: '0.2.0',
          installedVersion: '0.2.0',
          drift: false,
        },
      ],
    });

    renderBadges();

    expect(await screen.findByText('v0.2.0')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '注入' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '更新' })).not.toBeInTheDocument();
  });

  it('shows success feedback after inject succeeds', async () => {
    const user = userEvent.setup();
    fetchProjectHarnessStatusMock.mockResolvedValue({
      packs: [
        {
          name: 'bdboard-harness',
          availableVersion: '0.2.0',
          installedVersion: null,
          drift: false,
        },
      ],
    });
    postProjectHarnessInjectMock.mockResolvedValue({
      packs: [
        {
          name: 'bdboard-harness',
          availableVersion: '0.2.0',
          installedVersion: '0.2.0',
          drift: false,
        },
      ],
    });

    renderBadges('/tmp/example-project');

    await user.click(await screen.findByRole('button', { name: '注入' }));

    await waitFor(() => {
      expect(postProjectHarnessInjectMock).toHaveBeenCalledWith(
        '/tmp/example-project',
        'bdboard-harness',
      );
    });
    expect(
      await screen.findByText('ハーネス bdboard-harness を注入しました'),
    ).toBeInTheDocument();
  });

  it('shows write-access error feedback when inject fails with 403', async () => {
    const user = userEvent.setup();
    fetchProjectHarnessStatusMock.mockResolvedValue({
      packs: [
        {
          name: 'bdboard-harness',
          availableVersion: '0.2.0',
          installedVersion: null,
          drift: false,
        },
      ],
    });
    postProjectHarnessInjectMock.mockRejectedValue(
      new ApiError(403, 'local access only', { errorMessage: 'local access only' }),
    );

    renderBadges();

    await user.click(await screen.findByRole('button', { name: '注入' }));

    expect(await screen.findByText(TUNNEL_WRITE_HELP)).toBeInTheDocument();
  });
});
