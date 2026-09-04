import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * チケット詳細パネルの閉じる/戻るボタンのタップ標的とヘッダー配置 (bdboard-h4xs.2)
 * を実ブラウザで確かめる。
 *
 * なぜ vitest では足りないか: 44px 最小ヒット領域、safe-area、スマホ幅での
 * ヘッダー縦積み (`.ticket-detail-header { flex-direction: column }`) — これらの
 * 効き目はすべて index.css のメディアクエリとクラス修飾に依存している。jsdom は
 * スタイルシートを読まないので、該当ルールを丸ごと消しても web の vitest は全部
 * グリーンのまま通る (実測: 97/97 pass)。
 *
 * PR#139 / PR#242 で同じ指摘が chat-maximize / ticket-detail-maximize 向けに
 * 出て e2e 層が追加されたのと同じ穴。ここも実測できる唯一の層なので、
 * boundingBox() で幅・高さ・位置を見る。
 */
// smoke.spec.ts と同じフィクスチャチケット。test/e2e/fixtures/bin/bd (スタブ bd
// CLI) が list に対してこれを返し、既定フィルタ (hideDone=true) でも見えるレーンに
// 入る。`.first()` のような順序依存のセレクタは使わない。
const TICKET_TITLE = 'Fixture ticket bdboard-3tw.8';

type Box = { x: number; y: number; width: number; height: number };

function expectMinTapTarget(box: Box, minSize = 44) {
  expect(box.width).toBeGreaterThanOrEqual(minSize);
  expect(box.height).toBeGreaterThanOrEqual(minSize);
}

function expectBoxInsideViewport(box: Box, viewportHeight: number) {
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewportHeight);
}

function rectanglesOverlap(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function boxInsideContainer(box: Box, container: Box): boolean {
  return (
    box.x >= container.x &&
    box.y >= container.y &&
    box.x + box.width <= container.x + container.width &&
    box.y + box.height <= container.y + container.height
  );
}

async function openTicketDetail(page: Page, useTap: boolean) {
  await page.goto('/');

  const card = page.locator('article', { hasText: TICKET_TITLE });
  await expect(card).toBeVisible({ timeout: 15_000 });
  if (useTap) {
    await card.tap();
  } else {
    await card.click();
  }

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function navigateToLinkedTicketViaDependency(dialog: Locator, page: Page) {
  // bdboard-3tw.2 は fixture 上 status=closed。既定フィルタ (hideDone) で盤面に
  // 出ず TicketIdLink が button ではなく span.ticket-id-unavailable になるため
  // getByRole('button') では掴めない。open な親 bdboard-3tw (parent-child 依存) を使う。
  const dependenciesSection = dialog
    .locator('.detail-section')
    .filter({ has: page.getByRole('heading', { name: 'Dependencies', exact: true }) });
  const dependencyLink = dependenciesSection.getByRole('button', {
    name: 'bdboard-3tw',
    exact: true,
  });
  await expect(dependencyLink).toBeVisible({ timeout: 15_000 });
  await dependencyLink.click();
  await expect(
    dialog.getByRole('button', { name: '前のチケットへ戻る' }),
  ).toBeVisible({ timeout: 15_000 });
}

test.describe('ticket detail close target on phone viewport', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test('close button is at least 44x44, inside the viewport, and closes the panel', async ({
    page,
  }) => {
    const dialog = await openTicketDetail(page, true);
    const closeBtn = dialog.getByRole('button', { name: '閉じる' });
    await expect(closeBtn).toBeVisible();

    const box = await closeBtn.boundingBox();
    expect(box).not.toBeNull();
    expectMinTapTarget(box!);
    expectBoxInsideViewport(box!, 812);

    await closeBtn.tap();
    await expect(dialog).not.toBeVisible();
  });

  test('action buttons sit below the title row (column header layout)', async ({
    page,
  }) => {
    const dialog = await openTicketDetail(page, true);
    const header = dialog.locator('.ticket-detail-header');
    const title = dialog.locator('h2#detail-title.detail-title');
    const actions = dialog.locator('.detail-header-actions');
    const closeBtn = dialog.getByRole('button', { name: '閉じる' });
    await expect(header).toBeVisible();
    await expect(title).toBeVisible();
    await expect(actions).toBeVisible();
    await expect(closeBtn).toBeVisible();

    const headerBox = await header.boundingBox();
    const titleBox = await title.boundingBox();
    const actionsBox = await actions.boundingBox();
    const closeBox = await closeBtn.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    expect(closeBox).not.toBeNull();

    // 縦積みなら閉じるボタンの y は見出しの下端以降。1行横並びなら同じ y 帯に来る。
    expect(closeBox!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height);

    // y の比較だけでは再配置ルール
    // (`.ticket-detail-header .detail-header-actions { width: 100% }` 等) を縛れない。
    // 長いタイトル (Fixture ticket bdboard-3tw.8) では、モバイル用ルールを全部消しても
    // アクション群が2行目へ回りうるため、y 比較だけだと通ってしまう (実測: 変異 M7 が生存)。
    // width: 100% があるときはアクション群がヘッダー内容幅いっぱい (~343px)、
    // 無いときは中身幅 (~100px) だけになるので、ヘッダー幅に対する比率で初めて縛れる。
    expect(actionsBox!.width).toBeGreaterThanOrEqual(headerBox!.width * 0.9);
  });
});

test.describe('ticket detail close target in 481-700px band', () => {
  test.use({ viewport: { width: 600, height: 800 } });

  test('close button is at least 44x44 between 481px and 700px', async ({ page }) => {
    const dialog = await openTicketDetail(page, false);
    const closeBtn = dialog.getByRole('button', { name: '閉じる' });
    await expect(closeBtn).toBeVisible();

    const box = await closeBtn.boundingBox();
    expect(box).not.toBeNull();
    expectMinTapTarget(box!);
    expectBoxInsideViewport(box!, 800);

    // 旧 @media (max-width: 480px) だけに 44px ルールが残る変異は、この帯では
    // min-height/min-width が効かずここで落ちる。
  });
});

test.describe('ticket detail header actions at minimum panel width on desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('back, maximize, and close controls do not overlap at 360px panel width', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('bdboard.ui.ticketDetailPanelWidth', '360');
    });

    const dialog = await openTicketDetail(page, false);
    await navigateToLinkedTicketViaDependency(dialog, page);

    const backBtn = dialog.getByRole('button', { name: '前のチケットへ戻る' });
    const maximizeBtn = dialog.getByRole('button', { name: '最大化' });
    const closeBtn = dialog.getByRole('button', { name: '閉じる' });
    await expect(backBtn).toBeVisible();
    await expect(maximizeBtn).toBeVisible();
    await expect(closeBtn).toBeVisible();

    const backBox = await backBtn.boundingBox();
    const maximizeBox = await maximizeBtn.boundingBox();
    const closeBox = await closeBtn.boundingBox();
    const dialogBox = await dialog.boundingBox();
    expect(backBox).not.toBeNull();
    expect(maximizeBox).not.toBeNull();
    expect(closeBox).not.toBeNull();
    expect(dialogBox).not.toBeNull();

    const boxes = [backBox!, maximizeBox!, closeBox!];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        expect(rectanglesOverlap(boxes[i], boxes[j])).toBe(false);
      }
      expect(boxInsideContainer(boxes[i], dialogBox!)).toBe(true);
    }
  });
});
