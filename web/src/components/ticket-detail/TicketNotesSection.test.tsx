import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TicketNotesSection } from './TicketNotesSection';

// bdboard-xfi7: notes は「これまでの経緯」として閉じた状態で出し、日付付きの件数と最終日を添える。
describe('TicketNotesSection', () => {
  it('renders nothing when notes is undefined', () => {
    const { container } = render(
      <TicketNotesSection notes={undefined} isTicketOnBoard={() => true} onOpenTicket={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders the history collapsed with the dated entry count and latest date', () => {
    const { container, getByText } = render(
      <TicketNotesSection
        notes={'2026-10-20: 最初の依頼\n2026-10-22: 案 A に決定'}
        isTicketOnBoard={() => true}
        onOpenTicket={vi.fn()}
      />,
    );

    expect(getByText('これまでの経緯')).toBeInTheDocument();
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    expect(getByText(/2 件・最終 2026-10-22/)).toBeInTheDocument();
  });
});
