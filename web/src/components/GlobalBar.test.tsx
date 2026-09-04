import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalBar } from './GlobalBar';

function renderGlobalBar(overrides?: Partial<React.ComponentProps<typeof GlobalBar>>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onViewChange = vi.fn();
  const props: React.ComponentProps<typeof GlobalBar> = {
    view: 'merged',
    onViewChange,
    notificationUnreadCount: 0,
    onOpenSearch: vi.fn(),
    streamState: 'open',
    lastContactAtMs: Date.now(),
    generatedAt: null,
    lastRefreshAt: null,
    totalSessionCount: 0,
    activeSessionCount: 0,
    onOpenSessionList: vi.fn(),
    statusDetailOpen: false,
    onStatusDetailOpenChange: vi.fn(),
    projects: [],
    selectedProjectIds: [],
    onToggleProject: vi.fn(),
    onSelectAllProjects: vi.fn(),
    onClearAllProjects: vi.fn(),
    onSaveProjectCombination: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenTunnel: vi.fn(),
    onOpenHelp: vi.fn(),
    onOpenShortcuts: vi.fn(),
    tipsBannerDismissed: false,
    onShowTipsBanner: vi.fn(),
    ...overrides,
  };
  const result = render(
    <QueryClientProvider client={queryClient}>
      <GlobalBar {...props} />
    </QueryClientProvider>,
  );
  return { ...props, onViewChange, container: result.container, unmount: result.unmount };
}

describe('GlobalBar view switcher a11y', () => {
  it('marks the active view with aria-current and omits it on inactive views', () => {
    renderGlobalBar({ view: 'next' });

    expect(screen.getByRole('button', { name: 'Next Up' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('button', { name: '統合' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: '統計' })).not.toHaveAttribute('aria-current');
  });

  it('does not use aria-pressed on view switcher buttons', () => {
    renderGlobalBar({ view: 'merged' });

    expect(screen.getByRole('button', { name: '統合' })).not.toHaveAttribute('aria-pressed');
  });

  it('calls onViewChange when a view button is clicked', async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderGlobalBar({ view: 'merged' });

    await user.click(screen.getByRole('button', { name: '統計' }));

    expect(onViewChange).toHaveBeenCalledWith('stats');
  });
});

describe('GlobalBar view switcher scroll', () => {
  let scrollIntoViewMock: ReturnType<typeof vi.fn>;
  let originalScrollIntoView: Element['scrollIntoView'] | undefined;

  beforeEach(() => {
    scrollIntoViewMock = vi.fn();
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
  });

  afterEach(() => {
    if (originalScrollIntoView !== undefined) {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    } else {
      // jsdom has no native scrollIntoView
      delete (HTMLElement.prototype as { scrollIntoView?: Element['scrollIntoView'] })
        .scrollIntoView;
    }
  });

  it('scrolls the active tab into view on mount with block nearest and inline center', () => {
    renderGlobalBar({ view: 'graph' });

    const activeButton = screen.getByRole('button', { name: '依存グラフ' });
    expect(activeButton).toHaveAttribute('aria-current', 'true');

    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'center',
    });
    expect(scrollIntoViewMock.mock.contexts.at(-1)).toBe(activeButton);
  });

  it('scrolls again when the active view changes via rerender', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const props: React.ComponentProps<typeof GlobalBar> = {
      view: 'merged',
      onViewChange: vi.fn(),
      notificationUnreadCount: 0,
      onOpenSearch: vi.fn(),
      streamState: 'open',
      lastContactAtMs: Date.now(),
      generatedAt: null,
      lastRefreshAt: null,
      totalSessionCount: 0,
      activeSessionCount: 0,
      onOpenSessionList: vi.fn(),
      statusDetailOpen: false,
      onStatusDetailOpenChange: vi.fn(),
      projects: [],
      selectedProjectIds: [],
      onToggleProject: vi.fn(),
      onSelectAllProjects: vi.fn(),
      onClearAllProjects: vi.fn(),
      onSaveProjectCombination: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenTunnel: vi.fn(),
      onOpenHelp: vi.fn(),
      onOpenShortcuts: vi.fn(),
      tipsBannerDismissed: false,
      onShowTipsBanner: vi.fn(),
    };

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <GlobalBar {...props} />
      </QueryClientProvider>,
    );

    scrollIntoViewMock.mockClear();

    rerender(
      <QueryClientProvider client={queryClient}>
        <GlobalBar {...props} view="graph" />
      </QueryClientProvider>,
    );

    const activeButton = screen.getByRole('button', { name: '依存グラフ' });
    expect(activeButton).toHaveAttribute('aria-current', 'true');
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'center',
    });
    expect(scrollIntoViewMock.mock.contexts.at(-1)).toBe(activeButton);
  });
});

describe('GlobalBar view switcher scroll hints', () => {
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

  function getScroller(container: HTMLElement) {
    const scroller = container.querySelector<HTMLElement>('.view-switcher-scroller');
    if (scroller === null) {
      throw new Error('view-switcher-scroller not found');
    }
    return scroller;
  }

  function getToggleGroup(container: HTMLElement) {
    const toggleGroup = container.querySelector<HTMLElement>('.view-switcher .toggle-group');
    if (toggleGroup === null) {
      throw new Error('toggle-group not found');
    }
    return toggleGroup;
  }

  it('applies no scroll hint classes on the scroller when content fits', () => {
    const { container } = renderGlobalBar();
    const toggleGroup = getToggleGroup(container);
    mockScrollMetrics(toggleGroup, { scrollWidth: 200, clientWidth: 200, scrollLeft: 0 });
    fireEvent.scroll(toggleGroup);

    const scroller = getScroller(container);
    expect(scroller).not.toHaveClass('can-scroll-start');
    expect(scroller).not.toHaveClass('can-scroll-end');
  });

  it('applies can-scroll-end only on the scroller when overflowed at the left edge', () => {
    const { container } = renderGlobalBar();
    const toggleGroup = getToggleGroup(container);
    mockScrollMetrics(toggleGroup, { scrollWidth: 300, clientWidth: 200, scrollLeft: 0 });
    fireEvent.scroll(toggleGroup);

    const scroller = getScroller(container);
    expect(scroller).not.toHaveClass('can-scroll-start');
    expect(scroller).toHaveClass('can-scroll-end');
  });

  it('applies both scroll hint classes on the scroller when overflowed and scrolled', () => {
    const { container } = renderGlobalBar();
    const toggleGroup = getToggleGroup(container);
    mockScrollMetrics(toggleGroup, { scrollWidth: 300, clientWidth: 200, scrollLeft: 50 });
    fireEvent.scroll(toggleGroup);

    const scroller = getScroller(container);
    expect(scroller).toHaveClass('can-scroll-start');
    expect(scroller).toHaveClass('can-scroll-end');
  });

  it('updates scroll hint classes via window resize when ResizeObserver is unavailable', () => {
    expect(typeof ResizeObserver).toBe('undefined');

    const { container } = renderGlobalBar();
    const toggleGroup = getToggleGroup(container);
    const scroller = getScroller(container);

    mockScrollMetrics(toggleGroup, { scrollWidth: 200, clientWidth: 200, scrollLeft: 0 });
    fireEvent(window, new Event('resize'));
    expect(scroller).not.toHaveClass('can-scroll-start');
    expect(scroller).not.toHaveClass('can-scroll-end');

    mockScrollMetrics(toggleGroup, { scrollWidth: 300, clientWidth: 200, scrollLeft: 0 });
    fireEvent(window, new Event('resize'));
    expect(scroller).not.toHaveClass('can-scroll-start');
    expect(scroller).toHaveClass('can-scroll-end');
  });

  it('does not throw when window resize fires after unmount (resize listener removed)', () => {
    expect(typeof ResizeObserver).toBe('undefined');

    const { container, unmount } = renderGlobalBar();
    const toggleGroup = getToggleGroup(container);
    mockScrollMetrics(toggleGroup, { scrollWidth: 300, clientWidth: 200, scrollLeft: 0 });

    unmount();

    expect(() => {
      fireEvent(window, new Event('resize'));
    }).not.toThrow();
  });
});
