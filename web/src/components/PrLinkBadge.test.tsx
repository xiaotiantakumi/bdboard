import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PrBadgeDto } from '../api';
import { PrLinkBadge } from './PrLinkBadge';

function makePrLink(overrides: Partial<PrBadgeDto> = {}): PrBadgeDto {
  return {
    ticketId: 'bdboard-1',
    projectId: 'proj-1',
    url: 'https://github.com/example-org/example-repo/pull/12',
    state: 'open',
    checkStatus: null,
    ...overrides,
  };
}

describe('PrLinkBadge', () => {
  it('renders nothing when prLink is undefined', () => {
    const { container } = render(<PrLinkBadge prLink={undefined} />);

    expect(container.textContent).toBe('');
  });

  it('renders open state with badge-pr-open class', () => {
    render(<PrLinkBadge prLink={makePrLink({ state: 'open' })} />);

    const link = screen.getByRole('link', { name: 'PR open' });
    expect(link).toHaveClass('badge-pr-open');
    expect(link).toHaveAttribute('href', 'https://github.com/example-org/example-repo/pull/12');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders merged state with badge-pr-merged class', () => {
    render(<PrLinkBadge prLink={makePrLink({ state: 'merged' })} />);

    expect(screen.getByRole('link', { name: 'PR merged' })).toHaveClass('badge-pr-merged');
  });

  it('renders closed state with badge-pr-closed class', () => {
    render(<PrLinkBadge prLink={makePrLink({ state: 'closed' })} />);

    expect(screen.getByRole('link', { name: 'PR closed' })).toHaveClass('badge-pr-closed');
  });

  it('renders unknown state with badge-pr-unknown when state is null', () => {
    render(<PrLinkBadge prLink={makePrLink({ state: null })} />);

    const link = screen.getByRole('link', { name: 'PR' });
    expect(link).toHaveClass('badge-pr-unknown');
    expect(link).toHaveAttribute('href', 'https://github.com/example-org/example-repo/pull/12');
  });

  it('shows fail check indicator when checkStatus is fail', () => {
    const { container } = render(
      <PrLinkBadge prLink={makePrLink({ checkStatus: 'fail' })} />,
    );

    expect(container.querySelector('.pr-check-fail')).not.toBeNull();
  });
});
