import { expect, test } from '@playwright/test';
import {
  DEFAULT_BULK_SELECTION_IDS,
  openBoardWithBulkActionBarCustomDefer,
  selectTickets,
  setBulkDeferPeriodCustom,
  waitForBulkActionBar,
} from './fixtures/bulk-selection.js';

/**
 * BulkActionBar のカスタム延期行レイアウト (bdboard-h4xs.11 / bdboard-53my)。
 *
 * @media (max-width: 480px) の `flex: 1 1 100%` が効いて延期グループが独立行になること、
 * および「完了」ボタンが単独全幅行にならないことを getBoundingClientRect で検証する。
 * toHaveClass だけでは「CSS が効いていない」失敗形をすり抜けるため、この層が必要。
 */

const TICKET_TITLE = 'Fixture ticket bdboard-3tw.8';
const ROW_Y_TOLERANCE_PX = 2;
const EDGE_TOLERANCE_PX = 0.5;
const FULL_WIDTH_RATIO = 0.9;
const DEFER_ROW_FULL_WIDTH_RATIO = 0.95;

interface RectSnapshot {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
}

interface ChildLayoutSnapshot {
  selectorHint: string;
  rect: RectSnapshot;
}

interface BulkButtonsLayoutMetrics {
  containerClientWidth: number;
  children: ChildLayoutSnapshot[];
  rowCount: number;
  deferGroupIndex: number;
  completeButtonIndex: number;
  deferGroupOnOwnRow: boolean;
  deferGroupOverlapsAnySibling: boolean;
  deferGroupWidthRatio: number;
  deferGroupSpansFullRow: boolean;
  completeButtonSharesRow: boolean;
  completeButtonWidthRatio: number;
  completeButtonNotSoloFullWidth: boolean;
}

async function measureBulkButtonsLayout(page: import('@playwright/test').Page): Promise<BulkButtonsLayoutMetrics> {
  return page.evaluate(
    ({ rowTolerance, edgeTolerance, fullWidthRatio, deferRowFullWidthRatio }) => {
      const container = document.querySelector('.bulk-action-bar .bulk-action-bar-buttons');
      if (!(container instanceof HTMLElement)) {
        throw new Error('bulk-action-bar-buttons not found');
      }

      const childElements = Array.from(container.children).filter(
        (node): node is HTMLElement => node instanceof HTMLElement,
      );

      const children = childElements.map((element) => {
        const rect = element.getBoundingClientRect();
        const classes = typeof element.className === 'string' ? element.className : '';
        const selectorHint =
          classes.includes('quick-action-defer-group-custom')
            ? 'defer-group-custom'
            : classes.includes('quick-action-defer-group')
              ? 'defer-group'
              : element.tagName.toLowerCase() === 'button'
                ? `button:${(element.textContent ?? '').trim()}`
                : element.className || element.tagName.toLowerCase();

        return {
          selectorHint,
          rect: {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            width: rect.width,
          },
        };
      });

      const deferGroupIndex = childElements.findIndex((element) =>
        element.classList.contains('quick-action-defer-group-custom'),
      );
      const completeButtonIndex = childElements.findIndex(
        (element) =>
          element instanceof HTMLButtonElement && element.textContent?.trim() === '完了',
      );

      const deferGroup = deferGroupIndex >= 0 ? children[deferGroupIndex] : undefined;
      const completeButton =
        completeButtonIndex >= 0 ? children[completeButtonIndex] : undefined;

      let deferGroupOverlapsAnySibling = false;
      let deferGroupOnOwnRow = deferGroup !== undefined;
      let deferGroupWidthRatio = 0;
      let deferGroupSpansFullRow = false;

      if (deferGroup !== undefined) {
        deferGroupWidthRatio =
          container.clientWidth > 0 ? deferGroup.rect.width / container.clientWidth : 0;
        deferGroupSpansFullRow = deferGroupWidthRatio >= deferRowFullWidthRatio;

        for (let index = 0; index < children.length; index += 1) {
          if (index === deferGroupIndex) {
            continue;
          }
          const sibling = children[index]!;
          const overlaps =
            deferGroup.rect.top < sibling.rect.bottom - edgeTolerance &&
            sibling.rect.top < deferGroup.rect.bottom - edgeTolerance;
          if (overlaps) {
            deferGroupOverlapsAnySibling = true;
            deferGroupOnOwnRow = false;
          }
        }

        if (deferGroupIndex > 0) {
          const prev = children[deferGroupIndex - 1]!;
          if (prev.rect.bottom > deferGroup.rect.top + edgeTolerance) {
            deferGroupOnOwnRow = false;
          }
        }
        if (deferGroupIndex >= 0 && deferGroupIndex < children.length - 1) {
          const next = children[deferGroupIndex + 1]!;
          if (next.rect.top < deferGroup.rect.bottom - edgeTolerance) {
            deferGroupOnOwnRow = false;
          }
        }
      } else {
        deferGroupOnOwnRow = false;
      }

      let completeButtonSharesRow = false;
      let completeButtonWidthRatio = 0;
      let completeButtonNotSoloFullWidth = false;

      if (completeButton !== undefined) {
        completeButtonWidthRatio =
          container.clientWidth > 0 ? completeButton.rect.width / container.clientWidth : 0;

        for (let index = 0; index < children.length; index += 1) {
          if (index === completeButtonIndex) {
            continue;
          }
          const sibling = children[index]!;
          const sameRow =
            Math.abs(sibling.rect.top - completeButton.rect.top) <= rowTolerance ||
            (completeButton.rect.top < sibling.rect.bottom - edgeTolerance &&
              sibling.rect.top < completeButton.rect.bottom - edgeTolerance);
          if (sameRow) {
            completeButtonSharesRow = true;
            break;
          }
        }

        completeButtonNotSoloFullWidth =
          completeButtonSharesRow ||
          completeButtonWidthRatio < fullWidthRatio;
      }

      return {
        containerClientWidth: container.clientWidth,
        children,
        rowCount: (() => {
          const rowTops: number[] = [];
          for (const child of children) {
            const existing = rowTops.find(
              (top) => Math.abs(top - child.rect.top) <= rowTolerance,
            );
            if (existing === undefined) {
              rowTops.push(child.rect.top);
            }
          }
          return rowTops.length;
        })(),
        deferGroupIndex,
        completeButtonIndex,
        deferGroupOnOwnRow,
        deferGroupOverlapsAnySibling,
        deferGroupWidthRatio,
        deferGroupSpansFullRow,
        completeButtonSharesRow,
        completeButtonWidthRatio,
        completeButtonNotSoloFullWidth,
      };
    },
    {
      rowTolerance: ROW_Y_TOLERANCE_PX,
      edgeTolerance: EDGE_TOLERANCE_PX,
      fullWidthRatio: FULL_WIDTH_RATIO,
      deferRowFullWidthRatio: DEFER_ROW_FULL_WIDTH_RATIO,
    },
  );
}

interface DetailQuickButtonsLayoutMetrics {
  containerClientWidth: number;
  rowCount: number;
  completeButtonSharesRow: boolean;
  completeButtonWidthRatio: number;
  completeButtonNotSoloFullWidth: boolean;
  deferGroupOverlapsAnySibling: boolean;
  bodyScrollWidth: number;
  viewportInnerWidth: number;
  horizontalOverflow: boolean;
}

async function measureDetailQuickButtonsLayout(
  page: import('@playwright/test').Page,
): Promise<DetailQuickButtonsLayoutMetrics> {
  return page.evaluate(
    ({ rowTolerance, edgeTolerance, fullWidthRatio }) => {
      const dialog = document.querySelector('[role="dialog"]');
      const container = dialog?.querySelector('.quick-action-buttons');
      if (!(container instanceof HTMLElement)) {
        throw new Error('detail panel quick-action-buttons not found');
      }

      const childElements = Array.from(container.children).filter(
        (node): node is HTMLElement => node instanceof HTMLElement,
      );

      const children = childElements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          rect: {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            width: rect.width,
          },
          isDeferGroup: element.classList.contains('quick-action-defer-group'),
          isCompleteButton:
            element instanceof HTMLButtonElement && element.textContent?.trim() === '完了',
        };
      });

      const deferGroupIndex = children.findIndex((child) => child.isDeferGroup);
      const completeButtonIndex = children.findIndex((child) => child.isCompleteButton);

      let deferGroupOverlapsAnySibling = false;
      if (deferGroupIndex >= 0) {
        const deferGroup = children[deferGroupIndex]!;
        for (let index = 0; index < children.length; index += 1) {
          if (index === deferGroupIndex) {
            continue;
          }
          const sibling = children[index]!;
          const overlaps =
            deferGroup.rect.top < sibling.rect.bottom - edgeTolerance &&
            sibling.rect.top < deferGroup.rect.bottom - edgeTolerance;
          if (overlaps) {
            deferGroupOverlapsAnySibling = true;
          }
        }
      }

      const completeButton =
        completeButtonIndex >= 0 ? children[completeButtonIndex] : undefined;

      let completeButtonSharesRow = false;
      let completeButtonWidthRatio = 0;
      let completeButtonNotSoloFullWidth = false;

      if (completeButton !== undefined) {
        completeButtonWidthRatio =
          container.clientWidth > 0
            ? completeButton.rect.width / container.clientWidth
            : 0;

        for (let index = 0; index < children.length; index += 1) {
          if (index === completeButtonIndex) {
            continue;
          }
          const sibling = children[index]!;
          const sameRow =
            Math.abs(sibling.rect.top - completeButton.rect.top) <= rowTolerance ||
            (completeButton.rect.top < sibling.rect.bottom - edgeTolerance &&
              sibling.rect.top < completeButton.rect.bottom - edgeTolerance);
          if (sameRow) {
            completeButtonSharesRow = true;
            break;
          }
        }

        completeButtonNotSoloFullWidth =
          completeButtonSharesRow ||
          completeButtonWidthRatio < fullWidthRatio;
      }

      const rowTops: number[] = [];
      for (const child of children) {
        const existing = rowTops.find(
          (top) => Math.abs(top - child.rect.top) <= rowTolerance,
        );
        if (existing === undefined) {
          rowTops.push(child.rect.top);
        }
      }

      return {
        containerClientWidth: container.clientWidth,
        rowCount: rowTops.length,
        completeButtonSharesRow,
        completeButtonWidthRatio,
        completeButtonNotSoloFullWidth,
        deferGroupOverlapsAnySibling,
        bodyScrollWidth: document.body.scrollWidth,
        viewportInnerWidth: window.innerWidth,
        horizontalOverflow: document.body.scrollWidth > window.innerWidth,
      };
    },
    {
      rowTolerance: ROW_Y_TOLERANCE_PX,
      edgeTolerance: EDGE_TOLERANCE_PX,
      fullWidthRatio: FULL_WIDTH_RATIO,
    },
  );
}

function assertBulkButtonsLayout(metrics: BulkButtonsLayoutMetrics, context: string): void {
  expect(
    metrics.deferGroupIndex,
    `${context}: custom defer group (.quick-action-defer-group-custom) must exist`,
  ).toBeGreaterThanOrEqual(0);

  expect(
    metrics.deferGroupOnOwnRow,
    `${context}: custom defer group must sit on its own row (no vertical overlap with siblings). ` +
      `children=${JSON.stringify(metrics.children, null, 2)}`,
  ).toBe(true);

  expect(
    metrics.deferGroupOverlapsAnySibling,
    `${context}: custom defer group must not overlap any sibling vertically`,
  ).toBe(false);

  expect(
    metrics.deferGroupSpansFullRow,
    `${context}: custom defer group row must span the container width ` +
      `(widthRatio=${metrics.deferGroupWidthRatio.toFixed(3)}, ` +
      `containerClientWidth=${metrics.containerClientWidth})`,
  ).toBe(true);

  // 観測点1: 単独全幅行を禁止。同一行に兄弟がいるか、幅がコンテナの 90% 未満なら OK。
  expect(
    metrics.completeButtonNotSoloFullWidth,
    `${context}: complete button must not occupy a solo full-width row ` +
      `(sharesRow=${metrics.completeButtonSharesRow}, ` +
      `widthRatio=${metrics.completeButtonWidthRatio.toFixed(3)}, ` +
      `containerClientWidth=${metrics.containerClientWidth}, ` +
      `children=${JSON.stringify(metrics.children, null, 2)})`,
  ).toBe(true);

  if (!metrics.completeButtonSharesRow) {
    expect(
      metrics.completeButtonWidthRatio,
      `${context}: when complete button is alone on its row, width ratio must stay below ${FULL_WIDTH_RATIO}`,
    ).toBeLessThan(FULL_WIDTH_RATIO);
  }

  expect(
    metrics.rowCount,
    `${context}: with custom defer selected, button area should use multiple rows`,
  ).toBeGreaterThanOrEqual(2);
}

const MOBILE_VIEWPORTS = [
  { width: 375, height: 812, label: '375x812' },
  { width: 480, height: 812, label: '480x812' },
] as const;

for (const viewport of MOBILE_VIEWPORTS) {
  test.describe(`bulk action bar custom defer row @ ${viewport.label}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: true,
      hasTouch: true,
    });

    test('custom defer group occupies its own row without breaking sibling rows', async ({
      page,
    }) => {
      test.setTimeout(60_000);

      await page.goto('/');
      const firstCard = page.locator('article').first();
      await expect(firstCard).toBeVisible({ timeout: 15_000 });

      await selectTickets(page, DEFAULT_BULK_SELECTION_IDS);
      await waitForBulkActionBar(page);

      const beforeCustom = await measureBulkButtonsLayout(page);

      await setBulkDeferPeriodCustom(page);
      const afterCustom = await measureBulkButtonsLayout(page);

      expect(
        afterCustom.rowCount,
        `${viewport.label}: selecting custom defer should not reduce row count ` +
          `(before=${beforeCustom.rowCount}, after=${afterCustom.rowCount})`,
      ).toBeGreaterThanOrEqual(beforeCustom.rowCount);

      assertBulkButtonsLayout(afterCustom, viewport.label);
    });
  });
}

for (const viewport of MOBILE_VIEWPORTS) {
  // bdboard-53my 条件4: 詳細パネル側を実測した結果、症状は無かった。
  // この describe はその状態を固定する回帰ガード。
  test.describe(`ticket detail quick actions custom defer @ ${viewport.label}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: true,
      hasTouch: true,
    });

    test('detail panel defer controls remain readable without solo full-width complete row', async ({
      page,
    }) => {
      test.setTimeout(60_000);

      // 詳細パネル (.quick-action-buttons) は BulkActionBar と異なり flex: 1 1 auto が無く、
      // 完了ボタンが単独全幅行になる症状は再現しなかった (bdboard-53my 実測済み)。
      await page.goto('/');

      const card = page.locator('article', { hasText: TICKET_TITLE });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('#comment-text')).toBeVisible({ timeout: 15_000 });

      const deferSelect = dialog.locator('select[aria-label="延期期間"]');
      await expect(deferSelect).toBeVisible();
      await deferSelect.selectOption('custom');
      await expect(dialog.locator('input[type="date"]')).toBeVisible();

      const metrics = await measureDetailQuickButtonsLayout(page);

      // 実測 (2026-09-05): 375px → rowCount=3 / 480px → rowCount=2。行数そのものは
      // ボタン本数とフォント次第で動くのでアサートしない。attach したメトリクスは
      // 将来この画面のレイアウトを追うときの基準値。
      await test.info().attach(`detail-panel-metrics-${viewport.label}`, {
        body: JSON.stringify(metrics, null, 2),
        contentType: 'application/json',
      });

      expect(
        metrics.horizontalOverflow,
        `${viewport.label} detail panel: body must not overflow horizontally ` +
          `(body.scrollWidth=${metrics.bodyScrollWidth}, innerWidth=${metrics.viewportInnerWidth})`,
      ).toBe(false);

      // 詳細パネル側には BulkActionBar のような `.btn { flex: 1 1 auto }` が無いため、
      // 完了ボタンは伸長せず単独全幅行にならない (実測: 375px で widthRatio=0.158 /
      // 480px で 0.121、いずれも同一行に兄弟あり)。ここはその性質を固定する回帰ガード。
      expect(
        metrics.completeButtonNotSoloFullWidth,
        `${viewport.label} detail panel: complete button must not occupy a solo full-width row ` +
          `(sharesRow=${metrics.completeButtonSharesRow}, ` +
          `widthRatio=${metrics.completeButtonWidthRatio.toFixed(3)}, ` +
          `containerClientWidth=${metrics.containerClientWidth})`,
      ).toBe(true);
    });
  });
}

test.describe('bulk selection helper smoke', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test('openBoardWithBulkActionBarCustomDefer reaches custom defer state', async ({ page }) => {
    await openBoardWithBulkActionBarCustomDefer(page);
    await expect(page.locator('.bulk-action-bar .quick-action-defer-group-custom')).toBeVisible();
    await expect(page.locator('.bulk-action-bar input[type="date"]')).toBeVisible();
  });
});
