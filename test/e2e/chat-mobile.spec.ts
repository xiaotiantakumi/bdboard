import { expect, test } from '@playwright/test';

/**
 * Mobile chat panel layout regressions (bdboard-ysm).
 *
 * These tests exercise the built SPA against a throwaway server with chat enabled
 * (see test/e2e/global-setup.ts). They verify tap targets stay inside the viewport
 * and that overlay stacking beats the undo snackbar — not overscroll chaining on
 * real iOS Safari (that fix is CSS-only; see index.css overscroll-behavior rules).
 */
test.describe('chat panel mobile layout', () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  async function openChatPanel(page: import('@playwright/test').Page) {
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 5_000 });
    const chatButton = page.getByRole('button', { name: 'チャット' });
    await expect(chatButton).toBeVisible({ timeout: 15_000 });
    await chatButton.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    return dialog;
  }

  function expectBoxInsideViewport(
    box: { x: number; y: number; width: number; height: number },
    viewportHeight: number,
  ) {
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewportHeight);
  }

  test('close button is visible and clickable on a phone-sized viewport', async ({
    page,
  }) => {
    const dialog = await openChatPanel(page);
    const closeBtn = dialog.getByRole('button', { name: '閉じる' });
    await expect(closeBtn).toBeVisible();

    const box = await closeBtn.boundingBox();
    expect(box).not.toBeNull();
    expectBoxInsideViewport(box!, 812);

    await closeBtn.click();
    await expect(dialog).not.toBeVisible();
  });

  test('close and send controls stay inside a shrunk viewport (keyboard proxy)', async ({
    page,
  }) => {
    const dialog = await openChatPanel(page);
    const closeBtn = dialog.getByRole('button', { name: '閉じる' });
    const sendBtn = dialog.getByRole('button', { name: '送信' });

    await page.setViewportSize({ width: 375, height: 400 });

    await expect(closeBtn).toBeVisible();
    await expect(sendBtn).toBeVisible();

    const closeBox = await closeBtn.boundingBox();
    const sendBox = await sendBtn.boundingBox();
    expect(closeBox).not.toBeNull();
    expect(sendBox).not.toBeNull();
    expectBoxInsideViewport(closeBox!, 400);
    expectBoxInsideViewport(sendBox!, 400);

    await closeBtn.click();
    await expect(dialog).not.toBeVisible();
  });

  test('overlay z-index stacks above undo snackbar', async ({ page }) => {
    await page.goto('/');

    const stacking = await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.style.display = 'flex';
      document.body.appendChild(overlay);

      const snackbar = document.createElement('div');
      snackbar.className = 'undo-snackbar';
      document.body.appendChild(snackbar);

      const overlayZ = Number.parseInt(getComputedStyle(overlay).zIndex, 10);
      const snackbarZ = Number.parseInt(getComputedStyle(snackbar).zIndex, 10);

      overlay.remove();
      snackbar.remove();

      return { overlayZ, snackbarZ };
    });

    expect(stacking.overlayZ).toBeGreaterThan(stacking.snackbarZ);
  });
});
