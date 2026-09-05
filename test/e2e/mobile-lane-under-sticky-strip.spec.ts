/**
 * bdboard-knrx: モバイルで最大スクロールしたとき、レーンが sticky な
 * `.lane-indicator-strip` の下へ潜らないことを固定する。
 *
 * ## 直していた症状 (修正前の実測, macOS Chromium 375x812, isMobile+hasTouch)
 *
 * | 量                                   | 修正前  | 修正後 |
 * |--------------------------------------|--------:|-------:|
 * | strip 下端 (= header 245 + strip 44) |     289 |    289 |
 * | 最大スクロール時のレーン上端         |  237.81 | 288.81 |
 * | **strip に隠れていたレーン上端**     |**51.19**|   0.19 |
 * | うち `.lane-header` (46.63px) の可視分|       0 |  46.63 |
 *
 * `.lane` の高さ上限が `calc(100dvh - 260px)` のリテラルで、260 の内訳が
 * strip 44 + 固定 padding 44 + **ヘッダー 245px のうち 172px だけ**だったのが原因
 * (ヘッダーが 203px だった頃の較正)。差の 73px が「上に 51px 潜り、下に 22px 余る」
 * という形で出ていた。
 *
 * ## 何を証明しているか
 *
 * 1. 最大スクロール位置で strip が実際に stuck していること (前提。ここが崩れると
 *    以下のアサートは「sticky が効いていないから重ならない」で空振りする)
 * 2. その状態でレーン全体 (上端も下端も) がビューポート内・strip の下端より下にあること
 * 3. `.lane` / `.board-section .lane` の高さ上限が **`--header-height` に追従する**こと。
 *    リテラルへ戻すミューテーションはここで落ちる — 2. だけだと「たまたま今のヘッダー高に
 *    合う別のリテラル」でも緑になってしまい、乖離が再発する構図が残る。
 */

import { expect, test, type Page } from '@playwright/test';

import {
  assertAiQuotaBadgeVisible,
  findWorstCaseTipIndex,
  installAiQuotaRoute,
  pinTipsBannerRandom,
  TIP_COUNT,
  waitForHeaderHeightConvergence,
} from './fixtures/mobile-chrome-helpers.js';

const MOBILE_VIEWPORT = { width: 375, height: 812 };

/** サブピクセル丸め (documentElement.scrollHeight は整数へ丸まる) の許容幅。 */
const SUBPIXEL_PX = 1;

/** 追従テストで --header-height に足す量。strip 44px より大きく取り、偶然の一致を排す。 */
const HEADER_PROBE_DELTA_PX = 60;

interface StickyGeometry {
  maxScrollY: number;
  scrollY: number;
  viewportHeight: number;
  headerBottom: number;
  stripTop: number;
  stripBottom: number;
  laneTops: number[];
  laneBottoms: number[];
  laneHeaderTop: number;
  laneHeaderBottom: number;
}

async function scrollToBottomAndMeasure(
  page: Page,
  laneSelector: string,
): Promise<StickyGeometry> {
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
  );
  return page.evaluate((selector) => {
    const px = (n: number) => Math.round(n * 100) / 100;
    const root = document.documentElement;
    const strip = document.querySelector('.lane-indicator-strip');
    const header = document.querySelector('.header');
    const lanes = Array.from(document.querySelectorAll(selector));
    const laneHeader = lanes[0]?.querySelector('.lane-header') ?? null;
    if (strip === null || header === null || lanes.length === 0 || laneHeader === null) {
      throw new Error(
        `sticky geometry: missing element (strip=${String(strip !== null)}, ` +
          `header=${String(header !== null)}, lanes=${lanes.length}, ` +
          `laneHeader=${String(laneHeader !== null)}) for selector ${selector}`,
      );
    }
    const stripRect = strip.getBoundingClientRect();
    const laneHeaderRect = laneHeader.getBoundingClientRect();
    return {
      maxScrollY: px(root.scrollHeight - root.clientHeight),
      scrollY: px(window.scrollY),
      viewportHeight: root.clientHeight,
      headerBottom: px(header.getBoundingClientRect().bottom),
      stripTop: px(stripRect.top),
      stripBottom: px(stripRect.bottom),
      laneTops: lanes.map((lane) => px(lane.getBoundingClientRect().top)),
      laneBottoms: lanes.map((lane) => px(lane.getBoundingClientRect().bottom)),
      laneHeaderTop: px(laneHeaderRect.top),
      laneHeaderBottom: px(laneHeaderRect.bottom),
    };
  }, laneSelector);
}

function describeGeometry(g: StickyGeometry): string {
  return (
    `maxScrollY=${g.maxScrollY}, scrollY=${g.scrollY}, viewportHeight=${g.viewportHeight}, ` +
    `headerBottom=${g.headerBottom}, strip=[${g.stripTop}, ${g.stripBottom}], ` +
    `laneTops=[${g.laneTops.join(', ')}], laneBottoms=[${g.laneBottoms.join(', ')}], ` +
    `laneHeader=[${g.laneHeaderTop}, ${g.laneHeaderBottom}]`
  );
}

/**
 * `--header-height` を delta px 増やしたときに、レーンの実高が同じだけ縮むことを測る。
 *
 * この 1 手で「上限がヘッダー実高に追従している」を直接見る。CSS を
 * `calc(100dvh - <literal>)` に戻すとレーン高は 1px も動かず落ちる。
 *
 * 事前条件として「今のレーン高 === 算出 max-height」も返す。上限が効いていない
 * (= コンテンツのほうが低い) 状態だと、この差分アサート自体が無意味になるため。
 */
async function measureHeaderTrackingDelta(
  page: Page,
  laneSelector: string,
  delta: number,
): Promise<{ before: number; after: number; maxHeightBefore: number }> {
  return page.evaluate(
    ({ selector, deltaPx }) => {
      const px = (n: number) => Math.round(n * 100) / 100;
      const lane = document.querySelector(selector);
      if (lane === null) {
        throw new Error(`header tracking: ${selector} not found`);
      }
      const root = document.documentElement;
      const readVar = getComputedStyle(root).getPropertyValue('--header-height').trim();
      const headerHeight = Number.parseFloat(readVar);
      if (!Number.isFinite(headerHeight)) {
        throw new Error(`header tracking: --header-height is not a px length (${readVar})`);
      }
      const before = px(lane.getBoundingClientRect().height);
      const maxHeightBefore = px(Number.parseFloat(getComputedStyle(lane).maxHeight));
      const previousInline = root.style.getPropertyValue('--header-height');
      root.style.setProperty('--header-height', `${headerHeight + deltaPx}px`);
      // 強制レイアウト後に読む。
      const after = px(lane.getBoundingClientRect().height);
      if (previousInline === '') {
        root.style.removeProperty('--header-height');
      } else {
        root.style.setProperty('--header-height', previousInline);
      }
      return { before, after, maxHeightBefore };
    },
    { selector: laneSelector, deltaPx: delta },
  );
}

function assertTracksHeaderHeight(
  m: { before: number; after: number; maxHeightBefore: number },
  label: string,
): void {
  // 上限が効いていない (= コンテンツのほうが低い) 状態だと、下の差分アサートは
  // 「レーン高が動かない」を正しく検出できない。先にそこを潰す。
  expect(
    Math.abs(m.before - m.maxHeightBefore),
    `${label}: レーンが高さ上限に達していないため、この差分テストは無意味 — ` +
      `height=${m.before}, max-height=${m.maxHeightBefore}`,
  ).toBeLessThanOrEqual(SUBPIXEL_PX);

  expect(
    m.before - m.after,
    `${label}: --header-height を ${HEADER_PROBE_DELTA_PX}px 増やしてもレーン高が同じだけ ` +
      `縮まない (before=${m.before}, after=${m.after})。max-height が --header-height では ` +
      `なくリテラルに戻っている (bdboard-knrx)。`,
  ).toBeGreaterThanOrEqual(HEADER_PROBE_DELTA_PX - SUBPIXEL_PX);
  expect(
    m.before - m.after,
    `${label}: --header-height の増分より大きくレーン高が縮んだ ` +
      `(before=${m.before}, after=${m.after})。二重に引いている可能性がある。`,
  ).toBeLessThanOrEqual(HEADER_PROBE_DELTA_PX + SUBPIXEL_PX);
}

async function gotoBoardWithWorstCaseChrome(page: Page): Promise<void> {
  await installAiQuotaRoute(page);
  await page.goto('/');
  await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.card').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.tips-banner')).toBeVisible();
  await waitForHeaderHeightConvergence(page);

  const worstCase = await findWorstCaseTipIndex(page);
  await pinTipsBannerRandom(page, worstCase.index, TIP_COUNT);
  await page.reload();
  await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.card').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.tips-banner')).toBeVisible();
  await assertAiQuotaBadgeVisible(page);
  await waitForHeaderHeightConvergence(page);
}

/**
 * 「スクロール余地がある」の下限。strip の自然位置が header 下端より下にある間は
 * stuck しないので、単に > 0 では足りない。実測では最小構成 (Tips 閉 + バー畳) でも
 * 80px あるので、その半分を床にする。
 */
const strictlyPositiveScrollFloor = 40;

function assertLaneClearOfStickyChrome(g: StickyGeometry, label: string): void {
  // 前提1: そもそもページがスクロールできること。ここが 0 だと strip は stuck せず、
  // 「重ならない」は sticky と無関係に成立してしまう。
  expect(
    g.maxScrollY,
    `${label}: ページ側にスクロール余地が無いと strip は stuck せず、以下のアサートが空振りする — ` +
      describeGeometry(g),
  ).toBeGreaterThan(strictlyPositiveScrollFloor);

  // 前提2: 最下部まで実際にスクロールできていること。
  expect(g.scrollY, `${label}: 最大スクロール位置まで到達していない — ${describeGeometry(g)}`).toBeGreaterThanOrEqual(
    g.maxScrollY - SUBPIXEL_PX,
  );

  // 前提3: strip が header 直下に stuck していること。
  expect(
    Math.abs(g.stripTop - g.headerBottom),
    `${label}: strip が header 直下に stuck していない (sticky が壊れた) — ${describeGeometry(g)}`,
  ).toBeLessThanOrEqual(SUBPIXEL_PX);

  for (const [index, laneTop] of g.laneTops.entries()) {
    expect(
      laneTop,
      `${label}: lane[${index}] の上端が sticky な .lane-indicator-strip の下に潜っている。` +
        `.lane の高さ上限が 100dvh からヘッダー実高 + strip 高 + 下側 padding を引いていないと` +
        `ここに出る (bdboard-knrx の元症状は 51.19px の潜り込み) — ${describeGeometry(g)}`,
    ).toBeGreaterThanOrEqual(g.stripBottom - SUBPIXEL_PX);
  }

  for (const [index, laneBottom] of g.laneBottoms.entries()) {
    expect(
      laneBottom,
      `${label}: lane[${index}] の下端がビューポート外にある — ${describeGeometry(g)}`,
    ).toBeLessThanOrEqual(g.viewportHeight + SUBPIXEL_PX);
  }

  // .lane-header はレーン内で最初に潜る要素。上の lane 上端アサートと同値だが、
  // 失敗時に「何が見えなくなったか」を名指しする。
  expect(
    g.laneHeaderTop,
    `${label}: .lane-header が strip の下に隠れている — ${describeGeometry(g)}`,
  ).toBeGreaterThanOrEqual(g.stripBottom - SUBPIXEL_PX);
  expect(
    g.laneHeaderBottom,
    `${label}: .lane-header の下端がビューポート外 — ${describeGeometry(g)}`,
  ).toBeLessThanOrEqual(g.viewportHeight);
}

test.describe('mobile lane vs sticky lane strip (bdboard-knrx)', () => {
  test.use({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });

  test('375x812: merged view keeps the whole lane below the stuck lane strip at max page scroll', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await gotoBoardWithWorstCaseChrome(page);

    assertLaneClearOfStickyChrome(
      await scrollToBottomAndMeasure(page, '.lanes-row .lane'),
      'merged view / filter collapsed',
    );

    // 絞り込みバーを展開してページ高を増やしても同じ (残差が増えても最悪ケースは変わらない)。
    await page.getByRole('button', { name: /^絞り込み/ }).click();
    await expect(page.locator('.board-filter-panel')).toBeVisible();
    await waitForHeaderHeightConvergence(page);

    assertLaneClearOfStickyChrome(
      await scrollToBottomAndMeasure(page, '.lanes-row .lane'),
      'merged view / filter expanded',
    );
  });

  test('375x812: lane height cap tracks --header-height instead of a literal', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await gotoBoardWithWorstCaseChrome(page);

    const merged = await measureHeaderTrackingDelta(
      page,
      '.lanes-row .lane',
      HEADER_PROBE_DELTA_PX,
    );
    assertTracksHeaderHeight(merged, 'merged view / .lane');

    // 分割ビューは .board-section .lane の別ルールで同じ式を書いている。片方だけ
    // リテラルへ戻る壊れ方があるので、両方見る。
    await page.getByRole('button', { name: '分割' }).click();
    await expect(page.locator('.board-section .lane').first()).toBeVisible({
      timeout: 15_000,
    });
    await waitForHeaderHeightConvergence(page);

    const split = await measureHeaderTrackingDelta(
      page,
      '.board-section .lane',
      HEADER_PROBE_DELTA_PX,
    );
    assertTracksHeaderHeight(split, 'split view / .board-section .lane');
  });
});
