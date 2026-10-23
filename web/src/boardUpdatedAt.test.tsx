import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BoardUpdatedAtContext, BoardUpdatedAtLabel, formatUpdatedAgo } from './boardUpdatedAt';

describe('formatUpdatedAgo', () => {
  const now = 10_000_000;
  it('says たった今更新 under a minute', () => {
    expect(formatUpdatedAgo(now - 30_000, now)).toBe('たった今更新');
  });
  it('says N分前に更新 under an hour', () => {
    expect(formatUpdatedAgo(now - 2 * 60_000, now)).toBe('2分前に更新');
    expect(formatUpdatedAgo(now - 59 * 60_000, now)).toBe('59分前に更新');
  });
  it('says N時間前に更新 from an hour', () => {
    expect(formatUpdatedAgo(now - 3 * 3_600_000, now)).toBe('3時間前に更新');
  });
});

describe('BoardUpdatedAtLabel', () => {
  it('renders nothing before data is fetched', () => {
    const { container } = render(
      <BoardUpdatedAtContext.Provider value={0}>
        <BoardUpdatedAtLabel />
      </BoardUpdatedAtContext.Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
  it('renders the relative text', () => {
    render(
      <BoardUpdatedAtContext.Provider value={Date.now() - 5 * 60_000}>
        <BoardUpdatedAtLabel />
      </BoardUpdatedAtContext.Provider>,
    );
    expect(screen.getByText('5分前に更新')).toBeInTheDocument();
  });
});
