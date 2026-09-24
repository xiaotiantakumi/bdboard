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

// bdboard-h4xs.27: クイックアクションはこの e2e フィクスチャ側のスタブ bd CLI
// (test/e2e/fixtures/bin/bd) では書き込みコマンドが未実装なので、実際にミューテーションを走らせて
// undo-snackbarを出すことはできない(実測: postTicketQuickAction が非0終了し、onSuccess が呼ばれず
// snackbar が一度も表示されないまま 5s タイムアウトする)。代わりに、実際の
// .overlay/.detail-panel/.undo-snackbar と同じ className 構造を DOM に直接注入し、
// 本物のスタイルシート(board-7.css の :has() ルールと ticket-detail-3.css の
// .overlay)が実際にどうカスケードされるかを getComputedStyle と elementFromPoint で検証する。
// z-index の数値だけでなく、スナックバーの実際の画面座標で elementFromPoint を使うのは
// chat-mobile.spec.ts の overlay z-index テスト(z-index の比較のみ)より一歩踏み込んだ確認。
async function assertUndoSnackbarStacking(
  page: Page,
  panelClassName: string,
  expectSnackbarOnTop: boolean,
) {
  const result = await page.evaluate(
    ({ panelClassName }) => {
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.style.display = 'flex';
      const panel = document.createElement('div');
      panel.className = panelClassName;
      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      const snackbar = document.createElement('div');
      snackbar.className = 'undo-snackbar';
      const action = document.createElement('button');
      action.className = 'undo-snackbar-action';
      action.textContent = '元に戻す';
      snackbar.appendChild(action);
      document.body.appendChild(snackbar);

      const overlayZ = Number.parseInt(getComputedStyle(overlay).zIndex, 10);
      const snackbarZ = Number.parseInt(getComputedStyle(snackbar).zIndex, 10);

      const rect = action.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      const snackbarIsHit = hit !== null && (hit === action || action.contains(hit) || hit === snackbar);

      overlay.remove();
      snackbar.remove();

      return { overlayZ, snackbarZ, snackbarIsHit };
    },
    { panelClassName },
  );

  if (expectSnackbarOnTop) {
    expect(result.snackbarZ, 'undo-snackbar z-index should beat .overlay').toBeGreaterThan(
      result.overlayZ,
    );
    expect(result.snackbarIsHit, 'undo-snackbar action must be the top hit target').toBe(true);
  } else {
    expect(result.overlayZ, '.overlay z-index should beat undo-snackbar (bdboard-ysm)').toBeGreaterThan(
      result.snackbarZ,
    );
    expect(
      result.snackbarIsHit,
      'undo-snackbar must stay obstructed while ChatPanel is open (bdboard-ysm regression guard)',
    ).toBe(false);
  }
}

// bdboard-h4xs.27: 実 DOM で実測した事実 — チケット詳細パネルを開いた状態からチャットを開いても、
// チケット詳細の .overlay/.detail-panel はアンマウントされずに .app の子として残ったまま、
// ChatPanel の .overlay が後発の兄弟として追加される(AppOverlayGroup.tsx の JSX 宣言順が
// TicketDetail→...→Chat の固定順のため)。assertUndoSnackbarStacking の単体ケース(chat-panel 単独)
// だけでは、この「2つの .overlay が同時にマウントされていて ChatPanel が最上位」という実際の
// バグ再現シナリオを見逃す(bdboard-h4xs.27 で :has() の二重ネストによる無効セレクタが一度これで
// 気づかれずに残った)。ここでは同じ構造を再現し、ChatPanel が最上位のときは常に snackbar が
// 保護されたまま(bdboard-ysm / PR #66 の回帰なし)であることを確認する。
async function assertUndoSnackbarStackingNested(page: Page) {
  const result = await page.evaluate(() => {
    const overlay1 = document.createElement('div');
    overlay1.className = 'overlay';
    overlay1.style.display = 'flex';
    const panel1 = document.createElement('div');
    panel1.className = 'detail-panel';
    overlay1.appendChild(panel1);
    document.body.appendChild(overlay1);

    const overlay2 = document.createElement('div');
    overlay2.className = 'overlay';
    overlay2.style.display = 'flex';
    const panel2 = document.createElement('div');
    panel2.className = 'detail-panel chat-panel';
    overlay2.appendChild(panel2);
    document.body.appendChild(overlay2);

    const snackbar = document.createElement('div');
    snackbar.className = 'undo-snackbar';
    const action = document.createElement('button');
    action.className = 'undo-snackbar-action';
    action.textContent = '元に戻す';
    snackbar.appendChild(action);
    document.body.appendChild(snackbar);

    const overlay2Z = Number.parseInt(getComputedStyle(overlay2).zIndex, 10);
    const snackbarZ = Number.parseInt(getComputedStyle(snackbar).zIndex, 10);
    const rect = action.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const snackbarIsHit = hit !== null && (hit === action || action.contains(hit) || hit === snackbar);

    overlay1.remove();
    overlay2.remove();
    snackbar.remove();

    return { overlay2Z, snackbarZ, snackbarIsHit };
  });

  expect(
    result.overlay2Z,
    '.overlay z-index should beat undo-snackbar when ChatPanel is topmost, even with another detail panel mounted underneath (bdboard-ysm)',
  ).toBeGreaterThan(result.snackbarZ);
  expect(
    result.snackbarIsHit,
    'undo-snackbar must stay obstructed while ChatPanel is topmost, even with a non-chat detail panel still mounted underneath (bdboard-h4xs.27 nested regression guard)',
  ).toBe(false);
}

// bdboard-u9vr: フィクスチャの stub bd CLI は書き込みサブコマンドを実装していないため
// (test/e2e/fixtures/bin/bd のコメント参照)、実際に bd へ書き込みを通すことはできない。
// chat-panel-helpers.ts の stubAgentsUnavailable() と同じパターンで、この2エンドポイント
// だけを page.route でモックし、本物の TicketDetailPanel / UndoSnackbar の成功時ロジック
// (useTicketQuickActions.ts の onSuccess)を実際に走らせる。GET 系(ticket/board の
// invalidateQueries による再取得)はモックしない — 実サーバー・実スタブのままでよい。
async function mockQuickActionEndpoints(page: Page) {
  await page.route('**/api/tickets/*/quick-action', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
  await page.route('**/api/tickets/*/quick-action/undo', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
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

  test('undo snackbar rises above a non-chat detail panel and stays reachable', async ({
    page,
  }) => {
    await page.goto('/');
    await assertUndoSnackbarStacking(page, 'detail-panel', true);
  });

  test('undo snackbar stays below the overlay when ChatPanel is open (bdboard-ysm guard)', async ({
    page,
  }) => {
    await page.goto('/');
    await assertUndoSnackbarStacking(page, 'detail-panel chat-panel', false);
  });

  test('undo snackbar stays below the overlay when ChatPanel is topmost over another open detail panel (bdboard-h4xs.27)', async ({
    page,
  }) => {
    await page.goto('/');
    await assertUndoSnackbarStackingNested(page);
  });

  test('a real quick action shows a real undo snackbar on top of a real ticket detail panel, and its action button is pressable (bdboard-u9vr)', async ({
    page,
  }) => {
    await mockQuickActionEndpoints(page);
    const dialog = await openTicketDetail(page, true);
    await dialog.getByRole('button', { name: '着手', exact: true }).click();
    const confirmPanel = dialog.locator('.quick-action-confirm-panel');
    await expect(confirmPanel).toBeVisible();
    await confirmPanel.getByRole('button', { name: '実行する' }).click();

    const snackbar = page.locator('.undo-snackbar');
    await expect(snackbar).toBeVisible();
    const actionBtn = page.locator('.undo-snackbar-action');
    await expect(actionBtn).toBeVisible();
    await expect(page.locator('.undo-snackbar-message')).toHaveText('着手しました');

    // 合成 DOM 注入ではなく、本物の .overlay / .detail-panel / .undo-snackbar に対して
    // 実測する(bdboard-u9vr: このファイルの他のテストは page.evaluate 内で偽の要素を
    // 作って調べているが、ここでは実要素を見る)。
    const stacking = await page.evaluate(() => {
      const overlay = document.querySelector('.overlay');
      const snackbarEl = document.querySelector('.undo-snackbar');
      const action = document.querySelector('.undo-snackbar-action');
      if (!overlay || !snackbarEl || !action) {
        throw new Error(
          'expected real .overlay/.undo-snackbar/.undo-snackbar-action to exist',
        );
      }
      const overlayZ = Number.parseInt(getComputedStyle(overlay).zIndex, 10);
      const snackbarZ = Number.parseInt(getComputedStyle(snackbarEl).zIndex, 10);
      const rect = action.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      const hitIsAction = hit !== null && (hit === action || action.contains(hit));
      return { overlayZ, snackbarZ, hitIsAction };
    });
    expect(
      stacking.snackbarZ,
      'real undo-snackbar z-index should beat the real .overlay',
    ).toBeGreaterThan(stacking.overlayZ);
    expect(
      stacking.hitIsAction,
      'undo-snackbar-action must be the real top hit target',
    ).toBe(true);

    // hit-test だけでなく実際に押して機能することまで確認する。
    await actionBtn.tap();
    await expect(page.locator('.undo-snackbar-message')).toHaveText('元に戻しました');
  });

  test('undo snackbar stays obstructed by a real ChatPanel opened from within the real ticket detail panel (bdboard-ysm / bdboard-h4xs.27 real-DOM regression, bdboard-u9vr)', async ({
    page,
  }) => {
    await mockQuickActionEndpoints(page);
    const dialog = await openTicketDetail(page, true);
    await dialog.getByRole('button', { name: '着手', exact: true }).click();
    await dialog
      .locator('.quick-action-confirm-panel')
      .getByRole('button', { name: '実行する' })
      .click();
    await expect(page.locator('.undo-snackbar')).toBeVisible();
    await expect(page.locator('.undo-snackbar-action')).toBeVisible();

    // チケット詳細パネル自身の「このチケットについてチャット」ボタンから本物の
    // ChatPanel を開く(ヘッダーの「チャット」ボタンではない — bdboard-h4xs.27 の
    // 実際のバグ再現手順そのもの)。
    await dialog.getByRole('button', { name: 'このチケットについてチャット' }).click();
    const chatDialog = page.locator('.chat-panel[role="dialog"]');
    await expect(chatDialog).toBeVisible();

    // チケット詳細パネルはアンマウントされずDOM上に残っている(bdboard-h4xs.27)。
    await expect(page.locator('.detail-panel:not(.chat-panel)')).toBeVisible();
    await expect(page.locator('.undo-snackbar-action')).toBeVisible();

    const stacking = await page.evaluate(() => {
      const overlays = Array.from(document.querySelectorAll('.overlay'));
      const snackbarEl = document.querySelector('.undo-snackbar');
      const action = document.querySelector('.undo-snackbar-action');
      if (overlays.length === 0 || !snackbarEl || !action) {
        throw new Error(
          'expected real .overlay (x2)/.undo-snackbar/.undo-snackbar-action to exist',
        );
      }
      const overlayZs = overlays.map((el) =>
        Number.parseInt(getComputedStyle(el).zIndex, 10),
      );
      const snackbarZ = Number.parseInt(getComputedStyle(snackbarEl).zIndex, 10);
      const rect = action.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      const hitIsAction = hit !== null && (hit === action || action.contains(hit));
      return { overlayZs, snackbarZ, hitIsAction };
    });
    for (const overlayZ of stacking.overlayZs) {
      expect(
        overlayZ,
        '.overlay z-index should beat undo-snackbar when a real ChatPanel is open (bdboard-ysm)',
      ).toBeGreaterThan(stacking.snackbarZ);
    }
    expect(
      stacking.hitIsAction,
      'undo-snackbar must stay obstructed while a real ChatPanel is open, even though it was opened from within the real ticket detail panel (bdboard-h4xs.27 real-DOM regression guard)',
    ).toBe(false);
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

test.describe('ticket detail undo snackbar on desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('undo snackbar rises above a non-chat detail panel and stays reachable', async ({
    page,
  }) => {
    await page.goto('/');
    await assertUndoSnackbarStacking(page, 'detail-panel', true);
  });
});
