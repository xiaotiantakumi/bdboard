import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModelStatsTableScroll } from './ModelStatsTableScroll';

function mockScrollMetrics(
  el: HTMLElement,
  metrics: { scrollWidth: number; clientWidth: number; scrollLeft: number },
) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: metrics.scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: metrics.clientWidth });
  Object.defineProperty(el, 'scrollLeft', {
    configurable: true,
    value: metrics.scrollLeft,
    writable: true,
  });
}

function getScrollContainer(container: HTMLElement) {
  const el = container.querySelector<HTMLElement>('.model-stats-table-scroll');
  if (el === null) {
    throw new Error('model-stats-table-scroll not found');
  }
  return el;
}

function getScroller(container: HTMLElement) {
  const el = container.querySelector<HTMLElement>('.model-stats-table-scroller');
  if (el === null) {
    throw new Error('model-stats-table-scroller not found');
  }
  return el;
}

describe('ModelStatsTableScroll', () => {
  it('omits region role, aria-label, and tabIndex when content does not overflow', () => {
    const { container } = render(
      <ModelStatsTableScroll ariaLabel="テスト表">
        <table className="model-stats-table">
          <tbody>
            <tr>
              <td>a</td>
              <td>b</td>
            </tr>
          </tbody>
        </table>
      </ModelStatsTableScroll>,
    );

    const scrollContainer = getScrollContainer(container);
    mockScrollMetrics(scrollContainer, { scrollWidth: 200, clientWidth: 200, scrollLeft: 0 });
    fireEvent.scroll(scrollContainer);

    expect(scrollContainer).not.toHaveAttribute('role');
    expect(scrollContainer).not.toHaveAttribute('aria-label');
    expect(scrollContainer).not.toHaveAttribute('tabindex');

    const scroller = getScroller(container);
    expect(scroller).not.toHaveClass('can-scroll-start');
    expect(scroller).not.toHaveClass('can-scroll-end');
  });

  it('applies region a11y props and scroll hint classes when content overflows', () => {
    const { container } = render(
      <ModelStatsTableScroll ariaLabel="テスト表">
        <table className="model-stats-table">
          <tbody>
            <tr>
              <td>a</td>
              <td>b</td>
            </tr>
          </tbody>
        </table>
      </ModelStatsTableScroll>,
    );

    const scrollContainer = getScrollContainer(container);
    mockScrollMetrics(scrollContainer, { scrollWidth: 400, clientWidth: 200, scrollLeft: 0 });
    fireEvent.scroll(scrollContainer);

    expect(scrollContainer).toHaveAttribute('role', 'region');
    expect(scrollContainer).toHaveAttribute('aria-label', 'テスト表');
    expect(scrollContainer).toHaveAttribute('tabindex', '0');

    const scroller = getScroller(container);
    expect(scroller).not.toHaveClass('can-scroll-start');
    expect(scroller).toHaveClass('can-scroll-end');
  });
});
