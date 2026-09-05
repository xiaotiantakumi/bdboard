import { expect, test } from '@playwright/test';
import {
  ensureProjectSelected,
  isInsideScrollContainer,
  openChatPanel,
  pastePngAttachment,
  pastePngAttachments,
  readChatPanelMetrics,
  readMessagesHeight,
  readPreviewSize,
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

  async function assertPanelNotOverflowing(page: import('@playwright/test').Page) {
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

    expect(
      await isInsideScrollContainer(
        page,
        '.chat-input-notices',
        '.chat-attachment',
        0,
      ),
    ).toBe(true);
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

  test('375x576 notices cap grows and messages stay readable with attachment', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 576 });
    await openChatPanel(page);
    await ensureProjectSelected(page);

    const textarea = page.locator('.chat-input');
    await pastePngAttachment(textarea, 'test-one.png');

    const noticesCap430 = 44;
    const noticesHeight = await page.locator('.chat-input-notices').evaluate((el) => {
      return el.getBoundingClientRect().height;
    });
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
    expect(
      await isInsideScrollContainer(
        page,
        '.chat-input-notices',
        '.chat-attachment',
        0,
      ),
    ).toBe(true);
  });
});
