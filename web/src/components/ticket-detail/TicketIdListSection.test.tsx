import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TicketIdListSection } from './TicketIdListSection';

// bdboard-sso1.5: 「Blocked By」「Blocks」の共通コンポーネント。0件時に何も描画
// しない挙動(移動前のインラインブロックと同一)と、ids ごとに TicketIdLink相当の
// 表示(盤面にあるIDはボタン、無いIDはリンク不可のspan)を検証する。
describe('TicketIdListSection', () => {
  it('renders nothing when ids is empty', () => {
    const { container } = render(
      <TicketIdListSection
        heading="Blocked By"
        ids={[]}
        isTicketOnBoard={() => true}
        onOpenTicket={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders the heading and a list item per id, routing through isTicketOnBoard/onOpenTicket', () => {
    const isTicketOnBoard = vi.fn((id: string) => id === 'MARK-on-board');
    const onOpenTicket = vi.fn();
    const { getByText, container } = render(
      <TicketIdListSection
        heading="MARK-heading"
        ids={['MARK-on-board', 'MARK-off-board']}
        isTicketOnBoard={isTicketOnBoard}
        onOpenTicket={onOpenTicket}
      />,
    );

    expect(getByText('MARK-heading')).toBeInTheDocument();
    expect(container.querySelectorAll('.detail-list li')).toHaveLength(2);

    const onBoardButton = getByText('MARK-on-board');
    expect(onBoardButton.tagName).toBe('BUTTON');
    onBoardButton.click();
    expect(onOpenTicket).toHaveBeenCalledWith('MARK-on-board');

    const offBoardSpan = getByText('MARK-off-board');
    expect(offBoardSpan.tagName).toBe('SPAN');
    expect(isTicketOnBoard).toHaveBeenCalledWith('MARK-on-board');
    expect(isTicketOnBoard).toHaveBeenCalledWith('MARK-off-board');
  });
});
