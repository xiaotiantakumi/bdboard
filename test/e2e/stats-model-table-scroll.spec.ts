import { expect, test, type Page } from '@playwright/test';

/**
 * Model stats table horizontal scroll (bdboard-83tc).
 * Targets the stage×model distribution table because countStageModelDistribution
 * has no date filter — unlike weekly closes, fixture columns stay stable over time.
 */

const MOBILE_VIEWPORT = { width: 375, height: 812 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const VIEWPORT_OFFSET_TOLERANCE_PX = 1;

interface HeaderReachResult {
  label: string;
  left: number;
  right: number;
  wrapperLeft: number;
  wrapperRight: number;
  fitsInWrapper: boolean;
}

interface WrapperScrollMetrics {
  scrollWidth: number;
  clientWidth: number;
  overflows: boolean;
  parentClientWidth: number;
  innerWidth: number;
}

function modelStatsSection(page: Page) {
  return page.getByRole('region', { name: 'モデル別実績' });
}

async function openStatsView(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '統計', exact: true }).click();
  await expect(modelStatsSection(page)).toBeVisible({ timeout: 15_000 });
}

function stageDistributionScroller(page: Page) {
  return modelStatsSection(page)
    .locator('.throughput-chart-block')
    .filter({
      has: page.getByRole('heading', { name: '工程×モデルの分布', level: 4 }),
    })
    .locator('.model-stats-table-scroller');
}

function stageDistributionWrapper(page: Page) {
  return modelStatsSection(page)
    .locator('.throughput-chart-block')
    .filter({
      has: page.getByRole('heading', { name: '工程×モデルの分布', level: 4 }),
    })
    .locator('.model-stats-table-scroll');
}

async function measureWrapperScroll(page: Page): Promise<WrapperScrollMetrics> {
  const wrapper = stageDistributionWrapper(page);
  await expect(wrapper).toBeVisible();

  return wrapper.evaluate((el) => {
    const parent = el.closest('.throughput-chart-block');
    const parentClientWidth =
      parent instanceof HTMLElement ? parent.clientWidth : Number.MAX_SAFE_INTEGER;
    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflows: el.scrollWidth > el.clientWidth,
      parentClientWidth,
      innerWidth: window.innerWidth,
    };
  });
}

async function assertAllHeadersReachableInWrapper(page: Page): Promise<HeaderReachResult[]> {
  const wrapper = stageDistributionWrapper(page);
  const headers = wrapper.locator('thead th');
  const count = await headers.count();

  expect(
    count,
    'stage×model table must expose header columns (fixture metadata may be missing)',
  ).toBeGreaterThan(1);

  const results: HeaderReachResult[] = [];

  for (let i = 0; i < count; i += 1) {
    const header = headers.nth(i);
    await header.evaluate((el) => {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });

    const metrics = await header.evaluate((el) => {
      const scrollWrapper = el.closest('.model-stats-table-scroll');
      if (!(scrollWrapper instanceof HTMLElement)) {
        return {
          label: el.textContent ?? '',
          left: 0,
          right: 0,
          wrapperLeft: 0,
          wrapperRight: 0,
          fitsInWrapper: false,
        };
      }
      const headerRect = el.getBoundingClientRect();
      const wrapperRect = scrollWrapper.getBoundingClientRect();
      const epsilon = 0.5;
      return {
        label: el.textContent ?? '',
        left: headerRect.left,
        right: headerRect.right,
        wrapperLeft: wrapperRect.left,
        wrapperRight: wrapperRect.right,
        fitsInWrapper:
          headerRect.left >= wrapperRect.left - epsilon &&
          headerRect.right <= wrapperRect.right + epsilon,
      };
    });

    results.push(metrics);
    expect(
      metrics.fitsInWrapper,
      `header "${metrics.label}" must fit within scroll wrapper after scrollIntoView ` +
        `(header=[${metrics.left}, ${metrics.right}], wrapper=[${metrics.wrapperLeft}, ${metrics.wrapperRight}])`,
    ).toBe(true);
  }

  return results;
}

async function assertScrollFadeHints(page: Page): Promise<void> {
  const scroller = stageDistributionScroller(page);
  const scrollContainer = stageDistributionWrapper(page);
  await expect(scroller).toBeVisible();

  await scrollContainer.evaluate((el) => {
    el.scrollLeft = 0;
  });

  await expect(scroller).toHaveClass(/can-scroll-end/);
  await expect(scroller).not.toHaveClass(/can-scroll-start/);

  await scrollContainer.evaluate((el) => {
    el.scrollLeft = el.scrollWidth - el.clientWidth;
  });

  await expect(scroller).toHaveClass(/can-scroll-start/);
  await expect(scroller).not.toHaveClass(/can-scroll-end/);
}

async function assertNoPageHorizontalPan(page: Page): Promise<void> {
  const wrapper = stageDistributionWrapper(page);
  await wrapper.evaluate((el) => {
    el.scrollLeft = el.scrollWidth - el.clientWidth;
  });

  const panMetrics = await page.evaluate(() => ({
    offsetLeft: window.visualViewport?.offsetLeft ?? 0,
    scrollX: window.scrollX,
  }));

  expect(
    Math.abs(panMetrics.offsetLeft),
    `page must not pan horizontally when table wrapper is scrolled ` +
      `(visualViewport.offsetLeft=${panMetrics.offsetLeft}, scrollX=${panMetrics.scrollX})`,
  ).toBeLessThanOrEqual(VIEWPORT_OFFSET_TOLERANCE_PX);
}

async function assertModelTableScrollBehavior(
  page: Page,
  options: { checkPagePan: boolean },
): Promise<void> {
  const emptyMessage = modelStatsSection(page).getByText(
    'モデル別の実績データはまだありません',
  );
  expect(
    await emptyMessage.count(),
    'fixture must include bdboard.model.* metadata on closed tickets',
  ).toBe(0);

  const scrollMetrics = await measureWrapperScroll(page);
  expect(
    scrollMetrics.overflows,
    `stage×model table must overflow horizontally ` +
      `(scrollWidth=${scrollMetrics.scrollWidth}, clientWidth=${scrollMetrics.clientWidth})`,
  ).toBe(true);

  await assertAllHeadersReachableInWrapper(page);

  expect(
    scrollMetrics.clientWidth,
    `scroll wrapper must stay within chart block ` +
      `(wrapper=${scrollMetrics.clientWidth}, block=${scrollMetrics.parentClientWidth})`,
  ).toBeLessThanOrEqual(scrollMetrics.parentClientWidth);
  expect(
    scrollMetrics.clientWidth,
    `scroll wrapper must stay within viewport ` +
      `(wrapper=${scrollMetrics.clientWidth}, innerWidth=${scrollMetrics.innerWidth})`,
  ).toBeLessThanOrEqual(scrollMetrics.innerWidth);

  await assertScrollFadeHints(page);

  if (options.checkPagePan) {
    await assertNoPageHorizontalPan(page);
  }
}

test.describe('stats model table scroll — mobile', () => {
  test.use({
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
  });

  test('375x812: all stage×model columns are reachable via in-wrapper scroll', async ({
    page,
  }) => {
    await openStatsView(page);
    await assertModelTableScrollBehavior(page, { checkPagePan: true });
  });
});

test.describe('stats model table scroll — desktop', () => {
  test.use({
    viewport: DESKTOP_VIEWPORT,
  });

  test('1280x800: all stage×model columns are reachable via in-wrapper scroll', async ({
    page,
  }) => {
    await openStatsView(page);
    await assertModelTableScrollBehavior(page, { checkPagePan: false });
  });
});
