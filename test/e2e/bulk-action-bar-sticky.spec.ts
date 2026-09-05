import { expect, test, type Page } from '@playwright/test';
import {
  DEFAULT_BULK_SELECTION_IDS,
  selectTickets,
  waitForBulkActionBar,
} from './fixtures/bulk-selection.js';

/**
 * BulkActionBar のモバイル固定配置と、カードを操作できる余白の不変条件
 * (bdboard-h4xs.19)。
 *
 * 以前の spec はバー自身の viewport 内配置とボタンの hit test だけを測り、
 * カードやレーンとの重なりを測っていなかった。そのため、1件を選択してバーが
 * 現れた瞬間に次のカードのチェックボックスを塞ぐ BLOCKER-1 を検出できなかった。
 * この spec はカードを36点で hit test し、レーンの下端補償、候補リスト、確認パネル、
 * デスクトップへの CSS 漏れまでを INV-1〜INV-7 として直接検証する。
 *
 * INV-1 は意図的に条件付きである。scrollTop=0 ではヘッダーとフィルタ類により
 * .lanes-scroll-region の上端が 620.48px、カード帯の上端が約 664.48px に来る。
 * したがってカード用の画面内余白は 375x812 でも 147.5px、375x667 では 2.5px しかない。
 * 後者は高さ178pxのバーを外しても2.5pxなので、無条件の「先頭でカードが1枚見える」は
 * 成立しない。バーの上に48px以上のカード帯を置ける測定点だけ、実際の可視カードを要求する。
 * クローム肥大は別チケット bdboard-qxt1 の対象であり、縮小後はこの条件が発火する点が増える。
 *
 * 修正前は maxScroll=626px。修正後はバーをフローから外しレーンを縮めた結果 436pxで、
 * maxScroll 時の lanes-scroll-region.bottom は 375x812 で 622.48px (bar.top=634px)、
 * 375x667 で 477.48px (bar.top=489px)、可視カードはそれぞれ2枚 / 1枚だった。
 * 修正後も先頭では両 viewport とも可視カード0枚であり、上記の条件付き判定と整合する。
 */

const TOLERANCE_PX = 1;
const MIN_CARD_BAND_PX = 48;

const MOBILE_VIEWPORTS = [
  { width: 375, height: 812, label: '375x812' },
  { width: 375, height: 667, label: '375x667' },
] as const;

type ScrollPoint = 'top' | 'middle' | 'bottom';

interface RectSnapshot {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

interface HitSnapshot {
  centerX: number;
  centerY: number;
  hitElementTag: string;
  hitElementClass: string;
  reachable: boolean;
}

interface CardSnapshot {
  index: number;
  id: string | null;
  rect: RectSnapshot;
  inViewportSampleCount: number;
  cardHitSampleCount: number;
  visibleNotCovered: boolean;
  checkbox: (HitSnapshot & { rect: RectSnapshot }) | null;
}

interface MobileGeometryMetrics {
  viewportLabel: string;
  point: ScrollPoint;
  innerWidth: number;
  innerHeight: number;
  scrollTop: number;
  scrollHeight: number;
  maxScroll: number;
  bodyScrollWidth: number;
  bulkBarHeightVar: string;
  barPosition: string;
  barRect: RectSnapshot;
  lanesRegionRect: RectSnapshot;
  headerRect: RectSnapshot;
  stripRect: RectSnapshot | null;
  laneCardsRect: RectSnapshot;
  visibleLaneCardsRects: RectSnapshot[];
  cards: CardSnapshot[];
  visibleNotCovered: number;
}

async function settleLayout(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function openBoardWithBulkSelection(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('article').first()).toBeVisible({ timeout: 15_000 });
  await selectTickets(page, DEFAULT_BULK_SELECTION_IDS);
  await waitForBulkActionBar(page);
  await settleLayout(page);
}

async function prepareMeasurement(page: Page, targetScrollTop: number): Promise<number> {
  await page.evaluate((target) => {
    window.scrollTo(0, target);
    // selectTickets().check() が scrollIntoView して変えたレーン内スクロールを毎回除去する。
    for (const laneCards of Array.from(
      document.querySelectorAll<HTMLElement>('.lane-cards'),
    )) {
      laneCards.scrollTop = 0;
    }
  }, targetScrollTop);
  await settleLayout(page);
  return page.evaluate(() => document.documentElement.scrollTop);
}

async function measureMobileGeometry(
  page: Page,
  viewportLabel: string,
  point: ScrollPoint,
): Promise<MobileGeometryMetrics> {
  return page.evaluate(
    ({ label, scrollPoint }) => {
      const rectSnapshot = (rect: DOMRect): RectSnapshot => ({
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      });
      const hitIdentity = (hit: Element | null) => ({
        hitElementTag: hit?.tagName.toLowerCase() ?? 'null',
        hitElementClass:
          hit instanceof HTMLElement && typeof hit.className === 'string' ? hit.className : '',
      });

      const bar = document.querySelector('.bulk-action-bar');
      const lanesRegion = document.querySelector('.lanes-scroll-region');
      const header = document.querySelector('.header');
      if (!(bar instanceof HTMLElement)) throw new Error('bulk-action-bar not found');
      if (!(lanesRegion instanceof HTMLElement)) throw new Error('lanes-scroll-region not found');
      if (!(header instanceof HTMLElement)) throw new Error('header not found');

      const strip = document.querySelector('.lane-indicator-strip');
      const visibleLaneCards = Array.from(
        document.querySelectorAll<HTMLElement>('.lane-cards'),
      ).filter((laneCards) => {
        const rect = laneCards.getBoundingClientRect();
        const style = getComputedStyle(laneCards);
        // 375x667 の top では rect.top≈674 で縦方向には完全に画面外だが、
        // INV-1 の available band を算出するためその top 自体が必要。
        // ここでの「可視中」は横スクロール上で見ているレーンを指す。
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > 0 &&
          rect.left < window.innerWidth
        );
      });
      if (visibleLaneCards.length === 0) throw new Error('visible lane-cards not found');

      const cards: CardSnapshot[] = Array.from(document.querySelectorAll('article')).map(
        (article, index) => {
          const rect = article.getBoundingClientRect();
          const sampledPoints = [0.2, 0.4, 0.6, 0.8].flatMap((xFraction) =>
            Array.from({ length: 9 }, (_, sampleIndex) => (sampleIndex + 1) / 10).map(
              (yFraction) => {
                const x = rect.left + rect.width * xFraction;
                const y = rect.top + rect.height * yFraction;
                if (x < 0 || x >= window.innerWidth || y < 0 || y >= window.innerHeight) {
                  return { inViewport: false, hitsCard: false };
                }
                const hit = document.elementFromPoint(x, y);
                return {
                  inViewport: true,
                  hitsCard: hit !== null && (hit === article || article.contains(hit)),
                };
              },
            ),
          );
          const checkboxLabel = article.querySelector('label.card-bulk-checkbox');
          const checkboxInput = checkboxLabel?.querySelector('input[type="checkbox"]');
          const checkbox =
            checkboxLabel instanceof HTMLElement && checkboxInput instanceof HTMLInputElement
              ? (() => {
                  const checkboxRect = checkboxLabel.getBoundingClientRect();
                  const centerX = checkboxRect.left + checkboxRect.width / 2;
                  const centerY = checkboxRect.top + checkboxRect.height / 2;
                  const hit = document.elementFromPoint(centerX, centerY);
                  return {
                    rect: rectSnapshot(checkboxRect),
                    centerX,
                    centerY,
                    ...hitIdentity(hit),
                    reachable:
                      hit !== null &&
                      (hit === checkboxLabel || checkboxLabel.contains(hit) || hit === checkboxInput),
                  };
                })()
              : null;

          return {
            index,
            id: article.querySelector('.card-id')?.textContent?.trim() ?? null,
            rect: rectSnapshot(rect),
            inViewportSampleCount: sampledPoints.filter((sample) => sample.inViewport).length,
            cardHitSampleCount: sampledPoints.filter((sample) => sample.hitsCard).length,
            visibleNotCovered: sampledPoints.some((sample) => sample.hitsCard),
            checkbox,
          };
        },
      );

      const barRect = bar.getBoundingClientRect();
      const barStyle = getComputedStyle(bar);
      const visibleLaneCardsRects = visibleLaneCards.map((laneCards) =>
        rectSnapshot(laneCards.getBoundingClientRect()),
      );

      return {
        viewportLabel: label,
        point: scrollPoint,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollTop: document.documentElement.scrollTop,
        scrollHeight: document.documentElement.scrollHeight,
        maxScroll: document.documentElement.scrollHeight - window.innerHeight,
        bodyScrollWidth: document.body.scrollWidth,
        bulkBarHeightVar: getComputedStyle(document.documentElement)
          .getPropertyValue('--bulk-bar-height')
          .trim(),
        barPosition: barStyle.position,
        barRect: rectSnapshot(barRect),
        lanesRegionRect: rectSnapshot(lanesRegion.getBoundingClientRect()),
        headerRect: rectSnapshot(header.getBoundingClientRect()),
        stripRect: strip instanceof HTMLElement ? rectSnapshot(strip.getBoundingClientRect()) : null,
        laneCardsRect: visibleLaneCardsRects[0]!,
        visibleLaneCardsRects,
        cards,
        visibleNotCovered: cards.filter((card) => card.visibleNotCovered).length,
      };
    },
    { label: viewportLabel, scrollPoint: point },
  );
}

function availableBandAboveBar(metrics: MobileGeometryMetrics): number {
  const bandTop = Math.max(
    0,
    metrics.headerRect.bottom,
    metrics.stripRect?.bottom ?? 0,
    metrics.laneCardsRect.top,
  );
  const bandBottom = Math.min(
    metrics.innerHeight,
    metrics.barRect.top,
    metrics.lanesRegionRect.bottom,
  );
  return bandBottom - bandTop;
}

function assertMobilePoint(metrics: MobileGeometryMetrics, context: string): void {
  // INV-4: fixed bar は全スクロール点で viewport 下端に貼り付く。
  expect(metrics.barPosition, `${context}: mobile bar position`).toBe('fixed');
  expect(metrics.barRect.bottom, `${context}: bar bottom must match viewport bottom`).toBeGreaterThanOrEqual(
    metrics.innerHeight - TOLERANCE_PX,
  );
  expect(metrics.barRect.bottom, `${context}: bar bottom must match viewport bottom`).toBeLessThanOrEqual(
    metrics.innerHeight + TOLERANCE_PX,
  );
  expect(metrics.barRect.top, `${context}: bar top must remain in viewport`).toBeGreaterThanOrEqual(
    -TOLERANCE_PX,
  );

  // INV-5: bar も body も横方向へ viewport をはみ出さない。
  expect(metrics.bodyScrollWidth, `${context}: body must not overflow horizontally`).toBeLessThanOrEqual(
    metrics.innerWidth,
  );
  expect(metrics.barRect.left, `${context}: bar left edge`).toBeGreaterThanOrEqual(-TOLERANCE_PX);
  expect(metrics.barRect.right, `${context}: bar right edge`).toBeLessThanOrEqual(
    metrics.innerWidth + TOLERANCE_PX,
  );

  // INV-1: カード帯を置ける測定点だけ、ヒットテスト上の可視カードを要求する。
  const availableBand = availableBandAboveBar(metrics);
  if (availableBand >= MIN_CARD_BAND_PX) {
    expect(
      metrics.visibleNotCovered,
      `${context}: ${availableBand.toFixed(2)}px is available above bar, so a card must be visible`,
    ).toBeGreaterThan(0);
  }

  // INV-2: 見えている最初のカードは、次の一括選択へ進めるチェックボックスを持つ。
  if (metrics.visibleNotCovered >= 1) {
    const firstVisibleCard = metrics.cards.find((card) => card.visibleNotCovered);
    expect(firstVisibleCard, `${context}: first visible card snapshot`).toBeDefined();
    expect(
      firstVisibleCard?.checkbox,
      `${context}: visible card ${firstVisibleCard?.id ?? '(unknown)'} must have a bulk checkbox`,
    ).not.toBeNull();
    expect(
      firstVisibleCard?.checkbox?.reachable,
      `${context}: checkbox for visible card ${firstVisibleCard?.id ?? '(unknown)'} must be hit-testable ` +
        `(hit=${firstVisibleCard?.checkbox?.hitElementTag}.${firstVisibleCard?.checkbox?.hitElementClass})`,
    ).toBe(true);
  }
}

async function attachJson(name: string, value: unknown): Promise<void> {
  await test.info().attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: 'application/json',
  });
}

async function measureLabelSuggestions(page: Page, viewportLabel: string) {
  const input = page.locator('.bulk-action-label-input');
  await input.fill('house');
  const suggestion = page
    .locator('ul.bulk-label-suggestions')
    .getByRole('button', { name: 'housekeeping', exact: true });
  await expect(suggestion).toBeVisible();

  return page.evaluate((label) => {
    const list = document.querySelector('ul.bulk-label-suggestions');
    const candidate = Array.from(list?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'housekeeping',
    );
    if (!(list instanceof HTMLElement)) throw new Error('bulk-label-suggestions not found');
    if (!(candidate instanceof HTMLButtonElement)) throw new Error('housekeeping suggestion not found');
    const listRect = list.getBoundingClientRect();
    const buttonRect = candidate.getBoundingClientRect();
    const centerX = buttonRect.left + buttonRect.width / 2;
    const centerY = buttonRect.top + buttonRect.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);
    return {
      viewportLabel: label,
      innerHeight: window.innerHeight,
      suggestionsRect: {
        top: listRect.top,
        bottom: listRect.bottom,
        left: listRect.left,
        right: listRect.right,
        width: listRect.width,
        height: listRect.height,
      },
      candidate: {
        centerX,
        centerY,
        hitElementTag: hit?.tagName.toLowerCase() ?? 'null',
        hitElementClass:
          hit instanceof HTMLElement && typeof hit.className === 'string' ? hit.className : '',
        reachable: hit !== null && (hit === candidate || candidate.contains(hit)),
      },
    };
  }, viewportLabel);
}

async function assertConfirmPanel(page: Page): Promise<void> {
  await page.locator('.bulk-action-label-input').fill('');
  await expect(page.locator('ul.bulk-label-suggestions')).toHaveCount(0);
  await page
    .locator('.bulk-action-bar')
    .getByRole('button', { name: '完了', exact: true })
    .click();

  const panel = page.locator('.bulk-action-confirm-panel');
  await expect(panel).toBeVisible();
  await settleLayout(page);

  const metrics = await page.evaluate(() => {
    const bar = document.querySelector('.bulk-action-bar');
    const confirmPanel = document.querySelector('.bulk-action-confirm-panel');
    if (!(bar instanceof HTMLElement)) throw new Error('bulk-action-bar not found');
    if (!(confirmPanel instanceof HTMLElement)) throw new Error('bulk-action-confirm-panel not found');

    const buttonHit = (text: string) => {
      const button = Array.from(confirmPanel.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === text,
      );
      if (!(button instanceof HTMLButtonElement)) throw new Error(`${text} button not found`);
      const rect = button.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(centerX, centerY);
      return {
        text,
        centerX,
        centerY,
        hitElementTag: hit?.tagName.toLowerCase() ?? 'null',
        hitElementClass:
          hit instanceof HTMLElement && typeof hit.className === 'string' ? hit.className : '',
        reachable: hit !== null && (hit === button || button.contains(hit)),
      };
    };

    const barRect = bar.getBoundingClientRect();
    return {
      innerHeight: window.innerHeight,
      barRect: {
        top: barRect.top,
        bottom: barRect.bottom,
        left: barRect.left,
        right: barRect.right,
        width: barRect.width,
        height: barRect.height,
      },
      barMaxHeight: getComputedStyle(bar).maxHeight,
      buttons: [buttonHit('キャンセル'), buttonHit('実行する')],
    };
  });

  await attachJson('inv-7-confirm-panel-375x812', metrics);
  expect(metrics.barRect.top, 'INV-7: expanded bar top must remain in viewport').toBeGreaterThanOrEqual(
    -TOLERANCE_PX,
  );
  expect(metrics.barRect.height, 'INV-7: max-height:70dvh must cap expanded bar').toBeLessThanOrEqual(
    metrics.innerHeight * 0.7 + TOLERANCE_PX,
  );
  for (const button of metrics.buttons) {
    expect(
      button.reachable,
      `INV-7: ${button.text} must be hit-testable ` +
        `(hit=${button.hitElementTag}.${button.hitElementClass})`,
    ).toBe(true);
  }

  // 一括操作は実行せず、測定後に確認パネルを閉じる。
  await panel.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(panel).toHaveCount(0);
}

for (const viewport of MOBILE_VIEWPORTS) {
  test.describe(`bulk action bar invariants @ ${viewport.label}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: true,
      hasTouch: true,
    });

    test('keeps cards reachable and compensated around the fixed bar', async ({ page }) => {
      test.setTimeout(60_000);
      await openBoardWithBulkSelection(page);

      const initialMaxScroll = await page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight,
      );
      expect(initialMaxScroll, `${viewport.label}: page must be vertically scrollable`).toBeGreaterThan(0);
      const targets: Array<{ point: ScrollPoint; scrollTop: number }> = [
        { point: 'top', scrollTop: 0 },
        { point: 'middle', scrollTop: Math.round(initialMaxScroll / 2) },
        { point: 'bottom', scrollTop: initialMaxScroll },
      ];

      for (const target of targets) {
        const actual = await prepareMeasurement(page, target.scrollTop);
        const metrics = await measureMobileGeometry(page, viewport.label, target.point);
        await attachJson(
          `bulk-action-bar-${viewport.label}-${target.point}`,
          {
            targetScrollTop: target.scrollTop,
            availableBandAboveBar: availableBandAboveBar(metrics),
            inv1Fires: availableBandAboveBar(metrics) >= MIN_CARD_BAND_PX,
            metrics,
          },
        );

        if (target.point === 'top') {
          expect(actual, `${viewport.label}: top measurement scrollTop`).toBe(0);
        }
        if (target.point === 'middle') {
          expect(actual, `${viewport.label}: middle must be below top`).toBeGreaterThan(0);
          expect(
            actual,
            `${viewport.label}: middle must not clamp to maxScroll ` +
              `(actual=${actual}, maxScroll=${metrics.maxScroll})`,
          ).toBeLessThan(metrics.maxScroll);
        }
        if (target.point === 'bottom') {
          expect(
            actual,
            `${viewport.label}: bottom measurement must reach maxScroll ` +
              `(actual=${actual}, maxScroll=${metrics.maxScroll})`,
          ).toBeGreaterThanOrEqual(metrics.maxScroll - TOLERANCE_PX);
        }

        assertMobilePoint(metrics, `${viewport.label} ${target.point}`);

        if (target.point === 'bottom') {
          // INV-3: 最下部ではレーン領域全体がバーの上に出て、カードを覆われない位置へ運べる。
          expect(
            metrics.lanesRegionRect.bottom,
            `${viewport.label}: compensated lanes region must end above bar at maxScroll`,
          ).toBeLessThanOrEqual(metrics.barRect.top + TOLERANCE_PX);
          expect(
            metrics.visibleNotCovered,
            `${viewport.label}: at least one card must be visible at maxScroll`,
          ).toBeGreaterThanOrEqual(1);
        }
      }

      // INV-6: 修正前の 375x812 は ul=809..847.58px / innerHeight=812px で、
      // 候補中心の elementFromPoint が null だった。上向き反転後は全体と候補中心が画面内にある。
      await prepareMeasurement(page, 0);
      const suggestions = await measureLabelSuggestions(page, viewport.label);
      await attachJson(`inv-6-label-suggestions-${viewport.label}`, suggestions);
      expect(suggestions.suggestionsRect.top, `${viewport.label}: suggestion top`).toBeGreaterThanOrEqual(
        -TOLERANCE_PX,
      );
      expect(
        suggestions.suggestionsRect.bottom,
        `${viewport.label}: suggestion bottom must stay in viewport`,
      ).toBeLessThanOrEqual(suggestions.innerHeight + TOLERANCE_PX);
      expect(
        suggestions.candidate.reachable,
        `${viewport.label}: housekeeping suggestion must be hit-testable ` +
          `(hit=${suggestions.candidate.hitElementTag}.${suggestions.candidate.hitElementClass})`,
      ).toBe(true);

      if (viewport.label === '375x812') {
        await assertConfirmPanel(page);
      }
    });
  });
}

test.describe('bulk action bar desktop regression', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('keeps static placement and downward label suggestions', async ({ page }) => {
    test.setTimeout(60_000);
    await openBoardWithBulkSelection(page);

    await page.locator('.bulk-action-label-input').fill('house');
    await expect(
      page
        .locator('ul.bulk-label-suggestions')
        .getByRole('button', { name: 'housekeeping', exact: true }),
    ).toBeVisible();

    const metrics = await page.evaluate(() => {
      const bar = document.querySelector('.bulk-action-bar');
      const lanesRegion = document.querySelector('.lanes-scroll-region');
      const labelGroup = document.querySelector('.bulk-action-label-group');
      const suggestions = document.querySelector('ul.bulk-label-suggestions');
      if (!(bar instanceof HTMLElement)) throw new Error('bulk-action-bar not found');
      if (!(lanesRegion instanceof HTMLElement)) throw new Error('lanes-scroll-region not found');
      if (!(labelGroup instanceof HTMLElement)) throw new Error('bulk-action-label-group not found');
      if (!(suggestions instanceof HTMLElement)) throw new Error('bulk-label-suggestions not found');
      const barRect = bar.getBoundingClientRect();
      const lanesRect = lanesRegion.getBoundingClientRect();
      const groupRect = labelGroup.getBoundingClientRect();
      const suggestionsRect = suggestions.getBoundingClientRect();
      const suggestionsStyle = getComputedStyle(suggestions);
      return {
        barPosition: getComputedStyle(bar).position,
        barBottom: barRect.bottom,
        lanesTop: lanesRect.top,
        labelGroupBottom: groupRect.bottom,
        suggestionsTop: suggestionsRect.top,
        suggestionsComputedTop: suggestionsStyle.top,
        suggestionsComputedBottom: suggestionsStyle.bottom,
      };
    });

    await attachJson('desktop-bulk-action-bar-regression', metrics);
    expect(metrics.barPosition, 'desktop bar must remain in normal flow').toBe('static');
    expect(metrics.barBottom, 'desktop bar must stay above card lanes').toBeLessThanOrEqual(
      metrics.lanesTop + TOLERANCE_PX,
    );
    // 絶対配置要素の getComputedStyle は used value を返すため、CSS の
    // bottom: auto は "auto" として観測できない（実測: -48.0469px）。
    // モバイルの上方向反転がデスクトップへ漏れていないことは幾何で確認する。
    // ul.bulk-label-suggestions は .label-suggestions 系の既存スタイルで上 margin
    // 8px を持つため、position:absolute; top:100%（= 親 .bulk-action-label-group の
    // 高さぶんの computed top、実測 29.1094px）でも矩形上端は親の下端より 8px 下になる。
    // |suggestionsTop - labelGroupBottom| <= 1px の完全一致要求は誤り（実測: 差 8px）。
    const resolvedTopPx = parseFloat(metrics.suggestionsComputedTop);
    expect(
      Number.isFinite(resolvedTopPx),
      `desktop suggestions must have resolved top (not auto; got ${metrics.suggestionsComputedTop})`,
    ).toBe(true);
    expect(
      metrics.suggestionsTop,
      `desktop suggestions must not flip above their group ` +
        `(computed top=${metrics.suggestionsComputedTop}, ` +
        `computed bottom=${metrics.suggestionsComputedBottom})`,
    ).toBeGreaterThanOrEqual(metrics.labelGroupBottom - TOLERANCE_PX);

    // この fixture には一括操作を実行せず undo snackbar を出す導線が無い。
    // 破壊的操作を追加してまでモバイル用 snackbar offset の漏れは測定しない。
  });
});
