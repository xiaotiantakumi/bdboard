import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  INITIAL_NEXT_UP_LOOP_PROGRESS,
  type NextUpLoopPhase,
  type NextUpLoopProgress,
  type NextUpRunLoopController,
} from '../nextUpRunLoop';
import { BatchRunProgressChip } from './BatchRunProgressChip';

function makeController(
  phase: NextUpLoopPhase,
  progress: Partial<NextUpLoopProgress> = {},
): NextUpRunLoopController {
  return {
    phase,
    progress: { ...INITIAL_NEXT_UP_LOOP_PROGRESS, ...progress },
    beginBatchRun: vi.fn(),
    stopBatchRun: vi.fn(),
  };
}

const chip = () => screen.queryByRole('group', { name: 'エージェントの一括実行' });

describe('BatchRunProgressChip (bdboard-mkm1.2)', () => {
  it('renders nothing before any batch run has started', () => {
    render(<BatchRunProgressChip batchRun={makeController('idle')} />);
    expect(chip()).not.toBeInTheDocument();
  });

  it('shows the current ticket and progress while running, and stops on ■ 停止', async () => {
    const user = userEvent.setup();
    const batchRun = makeController('running', {
      currentTicketId: 't-2',
      completedCount: 1,
      totalCount: 3,
    });
    render(<BatchRunProgressChip batchRun={batchRun} />);

    expect(chip()).toHaveTextContent('▶ 一括実行中');
    expect(screen.getByRole('status')).toHaveTextContent('現在: t-2 | 完了 1/3 | 失敗 0');

    await user.click(screen.getByRole('button', { name: '■ 停止' }));
    expect(batchRun.stopBatchRun).toHaveBeenCalledTimes(1);
  });

  it('disables the stop button while stopping', () => {
    render(
      <BatchRunProgressChip
        batchRun={makeController('stopping', { currentTicketId: 't-1', totalCount: 2 })}
      />,
    );
    expect(screen.getByRole('button', { name: '■ 停止中…' })).toBeDisabled();
  });

  it('keeps the last result after the batch ends until it is dismissed', async () => {
    const user = userEvent.setup();
    const finished = makeController('idle', {
      completedCount: 1,
      failedCount: 1,
      totalCount: 3,
      endReason: 'consecutive_failures',
      lastFailureReason: 'worktree を作れませんでした',
    });
    const { rerender } = render(<BatchRunProgressChip batchRun={finished} />);

    expect(screen.getByRole('status')).toHaveTextContent(
      '前回の実行: 中断(連続失敗) | 完了 1/3 | 失敗 1 | 未実行 1',
    );
    expect(chip()).toHaveTextContent('worktree を作れませんでした');
    expect(screen.queryByRole('button', { name: '■ 停止' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '一括実行の結果を閉じる' }));
    expect(chip()).not.toBeInTheDocument();

    // 同じ結果 (progress の参照が同じ) のまま再描画されても閉じたまま。
    rerender(<BatchRunProgressChip batchRun={{ ...finished }} />);
    expect(chip()).not.toBeInTheDocument();

    // 次の実行が始まれば (progress が差し替われば) 再び出す。
    rerender(
      <BatchRunProgressChip
        batchRun={makeController('running', { currentTicketId: 'n-1', totalCount: 1 })}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('現在: n-1 | 完了 0/1');
  });

  it('warns that a stopped ticket may still be running on the server', () => {
    render(
      <BatchRunProgressChip
        batchRun={makeController('idle', {
          currentTicketId: 't-1',
          totalCount: 2,
          endReason: 'stopped',
        })}
      />,
    );
    expect(chip()).toHaveTextContent('t-1 はサーバー側で実行中の可能性があります');
  });
});
