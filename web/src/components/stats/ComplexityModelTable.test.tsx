import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ComplexityModelRowDto, ComplexityModelStatsDto } from '../../api';
import { ComplexityModelTable } from './ComplexityModelTable';

function row(overrides: Partial<ComplexityModelRowDto> = {}): ComplexityModelRowDto {
  return {
    complexity: 'low',
    model: 'composer-2.5',
    ticketCount: 2,
    fixPushKnownCount: 2,
    fixPushTotal: 3,
    fixPushUnknownCount: 0,
    fixPushAverage: 1.5,
    ...overrides,
  };
}

function stats(overrides: Partial<ComplexityModelStatsDto> = {}): ComplexityModelStatsDto {
  return { rows: [row()], unrecordedTicketCount: 0, fixPushPendingCount: 0, ...overrides };
}

const HEADERS = [
  '複雑度',
  '実装モデル',
  'クローズ件数',
  '修正push平均',
  '修正push合計',
  '回数あり件数',
  '回数不明件数',
];

describe('ComplexityModelTable (bdboard-p5l.27)', () => {
  it('renders one row per complexity x model with the joined fix push numbers', () => {
    render(<ComplexityModelTable stats={stats()} />);

    const table = screen.getByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(headers).toEqual(HEADERS);

    const cells = within(within(table).getAllByRole('row')[1] as HTMLElement)
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
    expect(cells).toEqual(['low', 'composer-2.5', '2', '1.5', '3', '2', '0']);
  });

  it('shows 未記録 for a missing complexity or implement model instead of dropping the row', () => {
    render(
      <ComplexityModelTable
        stats={stats({
          rows: [
            row({ complexity: null, model: 'composer-2.5' }),
            row({ complexity: 'high', model: null }),
          ],
        })}
      />,
    );

    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(within(rows[0] as HTMLElement).getAllByRole('cell')[0]).toHaveTextContent('未記録');
    expect(within(rows[1] as HTMLElement).getAllByRole('cell')[1]).toHaveTextContent('未記録');
  });

  it('shows — (not 0) for the average and total when no ticket in the row has a known count', () => {
    render(
      <ComplexityModelTable
        stats={stats({
          rows: [
            row({
              ticketCount: 2,
              fixPushKnownCount: 0,
              fixPushTotal: 0,
              fixPushUnknownCount: 2,
              fixPushAverage: null,
            }),
          ],
        })}
      />,
    );

    const cells = within(within(screen.getByRole('table')).getAllByRole('row')[1] as HTMLElement)
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
    expect(cells).toEqual(['low', 'composer-2.5', '2', '—', '—', '0', '2']);
  });

  it('shows a known zero as 0.0 / 0 (a confirmed value, not unknown)', () => {
    render(
      <ComplexityModelTable
        stats={stats({
          rows: [row({ ticketCount: 1, fixPushKnownCount: 1, fixPushTotal: 0, fixPushAverage: 0 })],
        })}
      />,
    );

    const cells = within(within(screen.getByRole('table')).getAllByRole('row')[1] as HTMLElement)
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
    expect(cells.slice(3, 5)).toEqual(['0.0', '0']);
  });

  it('mentions the tickets with neither metadata recorded and the ones still being fetched', () => {
    render(
      <ComplexityModelTable stats={stats({ unrecordedTicketCount: 7, fixPushPendingCount: 3 })} />,
    );

    expect(
      screen.getByText(/複雑度も実装モデルも未記録のクローズ済みチケット 7\s*件は、この表に含めていません/),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('修正push回数を取得中のチケットが 3 件あります');
  });

  it('omits the pending and unrecorded notes when there is nothing to report', () => {
    render(<ComplexityModelTable stats={stats()} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/この表に含めていません/)).not.toBeInTheDocument();
  });

  it('shows an empty message and no table when no row exists', () => {
    render(<ComplexityModelTable stats={stats({ rows: [] })} />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(
      screen.getByText('複雑度または実装モデルが記録されたクローズ済みチケットはまだありません'),
    ).toBeInTheDocument();
  });

  // bdboard-83tc の再発防止: 列が増えて幅が溢れても全セルに届くよう、表は必ず横スクロール
  // コンテナ (.model-stats-table-scroll) の中にある。実際の到達性 (幅の計測) は jsdom では
  // 測れないので e2e (test/e2e/stats-model-table-scroll.spec.ts) が見る。
  it('keeps the table inside the horizontal scroll wrapper so every column stays reachable', () => {
    const { container } = render(<ComplexityModelTable stats={stats()} />);

    const table = screen.getByRole('table');
    expect(table.closest('.model-stats-table-scroll')).not.toBeNull();
    expect(container.querySelector('.model-stats-table-scroller')).not.toBeNull();
    for (const bodyRow of within(table).getAllByRole('row').slice(1)) {
      expect(within(bodyRow).getAllByRole('cell')).toHaveLength(HEADERS.length);
    }
  });
});
