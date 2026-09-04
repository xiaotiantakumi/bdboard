import { expect, test } from '@playwright/test';

/**
 * Board filter bar reachability on narrow viewports (bdboard-h4xs.4).
 * Label chips must scroll inside .board-filter-label-group; type chips may wrap.
 */

const MOBILE_VIEWPORT = { width: 375, height: 812 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

interface ChipReachResult {
  label: string;
  left: number;
  right: number;
  groupLeft: number;
  groupRight: number;
  fitsInGroup: boolean;
}

interface GroupScrollMetrics {
  scrollWidth: number;
  clientWidth: number;
  barClientWidth: number;
  overflows: boolean;
  fitsInBar: boolean;
}

interface ViewportFitResult {
  label: string;
  left: number;
  right: number;
  innerWidth: number;
  fitsInViewport: boolean;
}

async function measureGroupScroll(
  page: import('@playwright/test').Page,
  groupSelector: string,
): Promise<GroupScrollMetrics> {
  return page.evaluate(({ selector }) => {
    const group = document.querySelector(selector);
    const bar = document.querySelector('.board-filter-bar');
    if (!(group instanceof HTMLElement) || !(bar instanceof HTMLElement)) {
      return {
        scrollWidth: 0,
        clientWidth: 0,
        barClientWidth: 0,
        overflows: false,
        fitsInBar: false,
      };
    }
    return {
      scrollWidth: group.scrollWidth,
      clientWidth: group.clientWidth,
      barClientWidth: bar.clientWidth,
      overflows: group.scrollWidth > group.clientWidth,
      fitsInBar: group.clientWidth <= bar.clientWidth,
    };
  }, { selector: groupSelector });
}

async function assertAllChipsReachableInGroup(
  page: import('@playwright/test').Page,
  groupSelector: string,
): Promise<ChipReachResult[]> {
  const chips = page.locator(`${groupSelector} .toggle-btn`);
  const count = await chips.count();
  expect(count, `${groupSelector} must expose at least one chip`).toBeGreaterThan(0);

  const results: ChipReachResult[] = [];

  for (let i = 0; i < count; i += 1) {
    const chip = chips.nth(i);
    await chip.evaluate((el) => {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });

    const metrics = await chip.evaluate((el, selector) => {
      const group = document.querySelector(selector);
      if (!(group instanceof HTMLElement)) {
        return {
          label: el.textContent ?? '',
          left: 0,
          right: 0,
          groupLeft: 0,
          groupRight: 0,
          fitsInGroup: false,
        };
      }
      const chipRect = el.getBoundingClientRect();
      const groupRect = group.getBoundingClientRect();
      const epsilon = 0.5;
      return {
        label: el.textContent ?? '',
        left: chipRect.left,
        right: chipRect.right,
        groupLeft: groupRect.left,
        groupRight: groupRect.right,
        fitsInGroup:
          chipRect.left >= groupRect.left - epsilon &&
          chipRect.right <= groupRect.right + epsilon,
      };
    }, groupSelector);

    results.push(metrics);
    expect(
      metrics.fitsInGroup,
      `chip "${metrics.label}" must fit within ${groupSelector} after scrollIntoView ` +
        `(chip=[${metrics.left}, ${metrics.right}], group=[${metrics.groupLeft}, ${metrics.groupRight}])`,
    ).toBe(true);
  }

  return results;
}

async function assertAllChipsFitViewport(
  page: import('@playwright/test').Page,
  groupSelector: string,
): Promise<ViewportFitResult[]> {
  const chips = page.locator(`${groupSelector} .toggle-btn`);
  const count = await chips.count();
  expect(count, `${groupSelector} must expose at least one chip`).toBeGreaterThan(0);

  const results: ViewportFitResult[] = [];

  for (let i = 0; i < count; i += 1) {
    const chip = chips.nth(i);
    await chip.evaluate((el) => {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });

    const metrics = await chip.evaluate((el) => {
      const chipRect = el.getBoundingClientRect();
      const innerWidth = window.innerWidth;
      const epsilon = 0.5;
      return {
        label: el.textContent ?? '',
        left: chipRect.left,
        right: chipRect.right,
        innerWidth,
        fitsInViewport:
          chipRect.left >= -epsilon && chipRect.right <= innerWidth + epsilon,
      };
    });

    results.push(metrics);
    expect(
      metrics.fitsInViewport,
      `chip "${metrics.label}" must fit within viewport ` +
        `(chip=[${metrics.left}, ${metrics.right}], innerWidth=${metrics.innerWidth})`,
    ).toBe(true);
  }

  return results;
}

test.describe('board filter mobile reach — AC1 label chips', () => {
  test.use({
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
  });

  test('375x812: all label filter chips are reachable via in-group scroll', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.board-filter-bar')).toBeVisible({ timeout: 15_000 });

    const labelGroup = page.locator('.board-filter-label-group');
    await expect(labelGroup).toBeVisible();

    const labelCount = await labelGroup.locator('.toggle-btn').count();
    expect(
      labelCount,
      'fixture must expose enough labels to overflow at 375px',
    ).toBeGreaterThanOrEqual(10);

    const scrollMetrics = await measureGroupScroll(page, '.board-filter-label-group');
    expect(
      scrollMetrics.overflows,
      `label group must overflow horizontally ` +
        `(scrollWidth=${scrollMetrics.scrollWidth}, clientWidth=${scrollMetrics.clientWidth})`,
    ).toBe(true);
    expect(
      scrollMetrics.fitsInBar,
      `label group client width must not exceed filter bar ` +
        `(group=${scrollMetrics.clientWidth}, bar=${scrollMetrics.barClientWidth})`,
    ).toBe(true);

    await assertAllChipsReachableInGroup(page, '.board-filter-label-group');
  });
});

test.describe('board filter mobile reach — AC2 type chips', () => {
  test.use({
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
  });

  test('375x812: all type filter chips are reachable (wrap or scroll)', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.board-filter-bar')).toBeVisible({ timeout: 15_000 });

    const typeGroup = page.locator('.board-filter-type-group');
    await expect(typeGroup).toBeVisible();

    const typeCount = await typeGroup.locator('.toggle-btn').count();
    expect(typeCount, 'BOARD_ISSUE_TYPES must render type chips').toBe(5);

    await assertAllChipsFitViewport(page, '.board-filter-type-group');
  });
});

test.describe('board filter mobile reach — AC3 desktop unchanged', () => {
  test.use({
    viewport: DESKTOP_VIEWPORT,
  });

  test('1280x800: filter bar layout uses min-width:0 without breaking desktop', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.board-filter-bar')).toBeVisible({ timeout: 15_000 });

    const metrics = await page.evaluate(() => {
      const filterGroup = document.querySelector('.board-filter-group');
      const labelGroup = document.querySelector('.board-filter-label-group');
      const typeGroup = document.querySelector('.board-filter-type-group');
      const bar = document.querySelector('.board-filter-bar');

      return {
        filterGroupMinWidth: filterGroup
          ? getComputedStyle(filterGroup).minWidth
          : null,
        labelGroupMinWidth: labelGroup
          ? getComputedStyle(labelGroup).minWidth
          : null,
        labelOverflows:
          labelGroup instanceof HTMLElement
            ? labelGroup.scrollWidth > labelGroup.clientWidth
            : null,
        barClientWidth: bar instanceof HTMLElement ? bar.clientWidth : null,
        labelGroupClientWidth:
          labelGroup instanceof HTMLElement ? labelGroup.clientWidth : null,
        typeGroupClientWidth:
          typeGroup instanceof HTMLElement ? typeGroup.clientWidth : null,
      };
    });

    expect(
      metrics.filterGroupMinWidth,
      'board-filter-group min-width must be 0 for flex shrink',
    ).toBe('0px');
    expect(
      metrics.labelGroupMinWidth,
      'toggle-group inside filter group must allow shrink',
    ).toBe('0px');

    expect(
      metrics.labelGroupClientWidth,
      'label group must stay within filter bar at desktop width',
    ).toBeLessThanOrEqual(metrics.barClientWidth ?? Number.MAX_SAFE_INTEGER);

    // 1280px では横スクロール不要なのが正常。著者値 min-width:0 だけでは
    // デスクトップ挙動が変わったとは言えないが、グループがバー内に収まることは確認する。
    expect(
      metrics.typeGroupClientWidth,
      'type group must stay within filter bar at desktop width',
    ).toBeLessThanOrEqual(metrics.barClientWidth ?? Number.MAX_SAFE_INTEGER);
  });
});
