import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attributesSummary } from './ticketAttributesSummary';
import {
  ATTRIBUTES_OPEN_KEY,
  TicketAttributesDetails,
} from './TicketAttributesDetails';
import { copyLabel, TicketIdCopyButton } from './TicketIdCopyButton';

describe('attributesSummary', () => {
  it('joins status, priority, type and labels', () => {
    expect(
      attributesSummary({
        status: 'open',
        priority: 2,
        issueType: 'task',
        labels: ['human', 'ui'],
      }),
    ).toBe('open · P2 · task · human, ui');
  });
  it('omits labels when there are none', () => {
    expect(
      attributesSummary({
        status: 'open',
        priority: 1,
        issueType: 'bug',
        labels: [],
      }),
    ).toBe('open · P1 · bug');
  });
});

describe('copyLabel', () => {
  it('maps each state', () => {
    expect(copyLabel('idle', 'x-1')).toBe('x-1');
    expect(copyLabel('copied', 'x-1')).toBe('コピーしました ✓');
    expect(copyLabel('error', 'x-1')).toBe('コピーできませんでした');
  });
});

describe('TicketIdCopyButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it('copies the id, shows the copied state, then reverts after 1.5s', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<TicketIdCopyButton ticketId="bdboard-1" />);
    const button = screen.getByRole('button', { name: 'チケット番号をコピー' });
    expect(button.textContent).toBe('bdboard-1');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith('bdboard-1');
    expect(button.textContent).toBe('コピーしました ✓');
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(button.textContent).toBe('bdboard-1');
  });

  it('shows an error when neither clipboard path works', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn().mockReturnValue(false),
      configurable: true,
    });
    render(<TicketIdCopyButton ticketId="bdboard-1" />);
    const button = screen.getByRole('button', { name: 'チケット番号をコピー' });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.textContent).toBe('コピーできませんでした');
  });
});

describe('TicketAttributesDetails', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('is closed by default and shows the summary', () => {
    const { container } = render(
      <TicketAttributesDetails summary="open · P2 · task">
        <div>body</div>
      </TicketAttributesDetails>,
    );
    expect(container.querySelector('details')?.open).toBe(false);
    expect(screen.getByText('詳細情報')).toBeTruthy();
    expect(screen.getByText('open · P2 · task')).toBeTruthy();
  });

  it('restores the open state from localStorage', () => {
    localStorage.setItem(ATTRIBUTES_OPEN_KEY, '1');
    const { container } = render(
      <TicketAttributesDetails summary="s">
        <div>body</div>
      </TicketAttributesDetails>,
    );
    expect(container.querySelector('details')?.open).toBe(true);
  });

  it('persists toggling', () => {
    const { container } = render(
      <TicketAttributesDetails summary="s">
        <div>body</div>
      </TicketAttributesDetails>,
    );
    const details = container.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(localStorage.getItem(ATTRIBUTES_OPEN_KEY)).toBe('1');
  });
});
