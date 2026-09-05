import { expect, test, type Page } from '@playwright/test';
import {
  ensureProjectSelected,
  isInsideScrollContainer,
  openChatPanel,
  pastePngAttachment,
  pastePngAttachments,
  readChatPanelMetrics,
  readMessagesHeight,
  readNoticesHeight,
  readNoticesScrollHeight,
  readPreviewSize,
  stubAgentsUnavailable,
  waitForFirstAttachmentPreview,
} from './fixtures/chat-panel-helpers.js';

/** 375×430 で添付時も会話領域が潰れないこと (bdboard-7fsw AC1)。 */
const MIN_MESSAGES_HEIGHT_PX = 40;

/**
 * 短いビューポートでの添付 UI 回帰 (bdboard-7fsw)。
 * toBeVisible() は高さ 0 の潰れを検出できないため、getBoundingClientRect() を assert する。
 */
test.describe('chat short viewport attachments', () => {
  test.use({
    viewport: { width: 375, height: 430 },
    isMobile: true,
    hasTouch: true,
  });

  async function assertPanelNotOverflowing(page: Page) {
    await expect
      .poll(
        async () =>
          page.locator('.chat-panel').evaluate((el) => el.scrollHeight - el.clientHeight),
        { timeout: 10_000 },
      )
      .toBeLessThanOrEqual(0);
  }

  test('375x430 keeps chat messages readable with one attachment', async ({ page }) => {
    await openChatPanel(page);
    await ensureProjectSelected(page);

    const textarea = page.locator('.chat-input');
    await pastePngAttachment(textarea, 'test-one.png');
    await expect(page.locator('.chat-attachment')).toHaveCount(1);

    await assertPanelNotOverflowing(page);

    const messagesHeight = await readMessagesHeight(page);
    const metrics = await readChatPanelMetrics(page);
    console.log(
      JSON.stringify({
        case: '375x430-attachments-1-messages-height',
        messagesHeight,
        panelMetrics: metrics,
      }),
    );
    expect(messagesHeight).toBeGreaterThanOrEqual(MIN_MESSAGES_HEIGHT_PX);

    // display: none は .chat-input-form:has(.chat-input-notices:not(:empty)) .chat-quick-commands
    // ルールを守る。
    expect(
      await page.locator('.chat-quick-commands').evaluate((el) => getComputedStyle(el).display),
    ).toBe('none');

    // rowGap === '2px' は .detail-panel.chat-panel:has(.chat-input-notices:not(:empty)) ルールを守る。
    // gap の寄与 9.25px はまるごと閾値 40px の余裕に収まってしまうので、
    // messagesHeight >= 40 ではこのルールの欠落を検出できない (bdboard-7fsw レビュー major-2)。
    expect(
      await page.locator('.chat-panel').evaluate((el) => getComputedStyle(el).rowGap),
    ).toBe('2px');

    expect(
      await isInsideScrollContainer(
        page,
        '.chat-input-notices',
        '.chat-attachment',
        0,
      ),
    ).toBe(true);
  });

  test('375x430 keeps chat messages readable when the agent is unavailable with no attachments', async ({
    page,
  }) => {
    // チケット表題そのものの症状が添付ゼロで再現する経路。パネル gap の述語が
    // .has-attachments のままだと quick-commands 隠しだけ効き、messages が 40.125px の knife-edge になる。
    await stubAgentsUnavailable(page);
    await openChatPanel(page);
    await ensureProjectSelected(page);

    await expect(page.locator('.chat-agent-unavailable-banner')).toBeVisible();
    await expect(page.locator('.chat-attachment')).toHaveCount(0);

    await assertPanelNotOverflowing(page);

    const messagesHeight = await readMessagesHeight(page);
    const metrics = await readChatPanelMetrics(page);
    console.log(
      JSON.stringify({
        case: '375x430-agent-unavailable-no-attachments',
        messagesHeight,
        panelMetrics: metrics,
      }),
    );
    expect(messagesHeight).toBeGreaterThanOrEqual(MIN_MESSAGES_HEIGHT_PX);

    expect(
      await page.locator('.chat-quick-commands').evaluate((el) => getComputedStyle(el).display),
    ).toBe('none');

    // この 1 行が無いと 40.125px で閾値を通り抜けてしまい、パネル gap の述語の退行が
    // 検出できない (375×430 実測)。
    expect(
      await page.locator('.chat-panel').evaluate((el) => getComputedStyle(el).rowGap),
    ).toBe('2px');
  });

  test('375x430 keeps chat messages readable with four attachments and five rejected', async ({
    page,
  }) => {
    await openChatPanel(page);
    await ensureProjectSelected(page);

    const textarea = page.locator('.chat-input');
    await pastePngAttachments(textarea, 4);
    await expect(page.locator('.chat-attachment')).toHaveCount(4);

    await assertPanelNotOverflowing(page);

    let messagesHeight = await readMessagesHeight(page);
    let metrics = await readChatPanelMetrics(page);
    console.log(
      JSON.stringify({
        case: '375x430-attachments-4-messages-height',
        messagesHeight,
        panelMetrics: metrics,
      }),
    );
    expect(messagesHeight).toBeGreaterThanOrEqual(MIN_MESSAGES_HEIGHT_PX);

    await pastePngAttachment(textarea, 'test-rejected.png');
    await expect(page.locator('.chat-attachment-error')).toBeVisible();
    await expect(page.locator('.chat-attachment-unsupported')).toBeVisible();

    await assertPanelNotOverflowing(page);

    messagesHeight = await readMessagesHeight(page);
    metrics = await readChatPanelMetrics(page);
    console.log(
      JSON.stringify({
        case: '375x430-attachments-5-rejected-messages-height',
        messagesHeight,
        panelMetrics: metrics,
      }),
    );
    expect(messagesHeight).toBeGreaterThanOrEqual(MIN_MESSAGES_HEIGHT_PX);
  });

  test('375x430 first attachment preview is at least 28px (notices cap floor)', async ({
    page,
  }) => {
    await openChatPanel(page);
    await ensureProjectSelected(page);

    const textarea = page.locator('.chat-input');
    await pastePngAttachment(textarea, 'test-one.png');
    await waitForFirstAttachmentPreview(page);

    const preview = await readPreviewSize(page);
    console.log(
      JSON.stringify({
        case: '375x430-preview-size',
        preview,
      }),
    );
    // 430dvh 帯では notices cap=44px、行高=preview+padding+border≒38px が上限。
    // preview を 44px に上げると先頭1枚すらコンテナに収まらない (実測 bdboard-7fsw)。
    // 要件は「識別可能な最小サイズ」= CSS 下限 28px。
    expect(preview.width).toBeGreaterThanOrEqual(28);
    expect(preview.height).toBeGreaterThanOrEqual(28);
  });

  test('375x500 crossover band keeps notices cap at 44px floor with one attachment', async ({
    page,
  }) => {
    // 469 は固定チャンク合計 421px からの導出値で、calc 項が動くのは 513〜565dvh。
    // このテストは「帯の手前ではまだ cap が育っていない」ことをピン留めする。
    await page.setViewportSize({ width: 375, height: 500 });
    await openChatPanel(page);
    await ensureProjectSelected(page);

    const textarea = page.locator('.chat-input');
    await pastePngAttachment(textarea, 'test-one.png');
    await expect(page.locator('.chat-attachment')).toHaveCount(1);

    const noticesHeight = await readNoticesHeight(page);
    const noticesScrollHeight = await readNoticesScrollHeight(page);
    const noticesClientHeight = await page
      .locator('.chat-input-notices')
      .evaluate((el) => el.clientHeight);
    const messagesHeight = await readMessagesHeight(page);
    const metrics = await readChatPanelMetrics(page);

    console.log(
      JSON.stringify({
        case: '375x500-crossover',
        noticesHeight,
        noticesScrollHeight,
        noticesClientHeight,
        messagesHeight,
        panelMetrics: metrics,
      }),
    );

    expect(noticesHeight).toBeLessThanOrEqual(44 + 0.5);
    expect(noticesScrollHeight).toBeGreaterThan(noticesClientHeight);

    await assertPanelNotOverflowing(page);
    expect(messagesHeight).toBeGreaterThanOrEqual(MIN_MESSAGES_HEIGHT_PX);

    // 500dvh は max-height:460px 帯外 — チップ列は表示されたまま (460 カットオフの両側)。
    expect(
      await page.locator('.chat-quick-commands').evaluate((el) => getComputedStyle(el).display),
    ).not.toBe('none');
  });

  test('375x576 notices cap grows and messages stay readable with attachment', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 576 });
    await openChatPanel(page);
    await ensureProjectSelected(page);

    const textarea = page.locator('.chat-input');
    await pastePngAttachment(textarea, 'test-one.png');
    await waitForFirstAttachmentPreview(page);

    const noticesCap430 = 44;
    const noticesHeight = await readNoticesHeight(page);
    const messagesHeight = await readMessagesHeight(page);
    const preview = await readPreviewSize(page);

    console.log(
      JSON.stringify({
        case: '375x576-notices-and-messages',
        noticesHeight,
        noticesCap430,
        messagesHeight,
        preview,
      }),
    );

    expect(noticesHeight).toBeGreaterThan(noticesCap430);
    expect(messagesHeight).toBeGreaterThanOrEqual(MIN_MESSAGES_HEIGHT_PX);
    // 576dvh では calc(100dvh - 485px) = 91 → clamp 上限 44px。
    // 485 を大きくすると下限 28px に落ちるのでここで落ちる。
    expect(preview.width).toBeGreaterThanOrEqual(44);
    expect(preview.height).toBeGreaterThanOrEqual(44);
    expect(
      await isInsideScrollContainer(
        page,
        '.chat-input-notices',
        '.chat-attachment',
        0,
      ),
    ).toBe(true);
  });

  test('375x576 four attachments bind notices cap at 96px', async ({ page }) => {
    // 1枚だけだと 94.59px で cap 96px に当たらないので、cap を守るには複数行必要。
    await page.setViewportSize({ width: 375, height: 576 });
    await openChatPanel(page);
    await ensureProjectSelected(page);

    const textarea = page.locator('.chat-input');
    await pastePngAttachments(textarea, 4);
    await expect(page.locator('.chat-attachment')).toHaveCount(4);

    const noticesHeight = await readNoticesHeight(page);
    const noticesScrollHeight = await readNoticesScrollHeight(page);
    const noticesClientHeight = await page
      .locator('.chat-input-notices')
      .evaluate((el) => el.clientHeight);
    const messagesHeight = await readMessagesHeight(page);
    const metrics = await readChatPanelMetrics(page);

    console.log(
      JSON.stringify({
        case: '375x576-attachments-4',
        noticesHeight,
        noticesScrollHeight,
        noticesClientHeight,
        messagesHeight,
        panelMetrics: metrics,
      }),
    );

    expect(noticesScrollHeight).toBeGreaterThan(noticesClientHeight);
    expect(noticesHeight).toBeLessThanOrEqual(96 + 0.5);

    await assertPanelNotOverflowing(page);
    expect(messagesHeight).toBeGreaterThanOrEqual(MIN_MESSAGES_HEIGHT_PX);
  });
});
