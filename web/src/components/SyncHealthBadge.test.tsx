import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SyncHealthDto } from '../api';
import { SyncHealthBadge } from './SyncHealthBadge';

function makeHealth(
  overrides: Partial<SyncHealthDto> & Pick<SyncHealthDto, 'status'>,
): SyncHealthDto {
  return {
    projectId: 'proj-1',
    reasons: [],
    ...overrides,
  };
}

describe('SyncHealthBadge', () => {
  it('renders nothing when health is undefined', () => {
    const { container } = render(<SyncHealthBadge health={undefined} />);

    expect(container.textContent).toBe('');
    expect(screen.queryByText('同期要確認')).not.toBeInTheDocument();
    expect(screen.queryByText('同期不明')).not.toBeInTheDocument();
  });

  it('renders nothing when status is ok', () => {
    const { container } = render(
      <SyncHealthBadge health={makeHealth({ status: 'ok' })} />,
    );

    expect(container.textContent).toBe('');
    expect(screen.queryByText('同期要確認')).not.toBeInTheDocument();
    expect(screen.queryByText('同期不明')).not.toBeInTheDocument();
  });

  it('renders attention badge with reason messages in title', () => {
    render(
      <SyncHealthBadge
        health={makeHealth({
          status: 'attention',
          reasons: [
            { kind: 'diverged_from_remote', message: 'リモートと乖離しています' },
            { kind: 'stale_export', message: 'エクスポートが古いです' },
          ],
        })}
      />,
    );

    const badge = screen.getByText(/同期要確認/);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute(
      'title',
      'リモートと乖離しています / エクスポートが古いです',
    );
  });

  it('renders unknown badge', () => {
    render(
      <SyncHealthBadge
        health={makeHealth({
          status: 'unknown',
          reasons: [{ kind: 'no_dolt_ref', message: 'Dolt ref がありません' }],
        })}
      />,
    );

    const badge = screen.getByText(/同期不明/);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', 'Dolt ref がありません');
  });
});
