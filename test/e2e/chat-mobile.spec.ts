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

  async function ensureProjectSelected(page: import('@playwright/test').Page) {
    // e2e フィクスチャはプロジェクト1件で自動選択されるため select は描画されない
    // (ChatPanel.tsx の showProjectSelect)。AC1 が言う「プロジェクト選択済み」は
    // この既定状態そのもの。
    const projectSelect = page.locator('#chat-project-select');
    if ((await projectSelect.count()) > 0) {
      await expect(projectSelect).toBeVisible({ timeout: 15_000 });
      await projectSelect.selectOption({ label: 'fixture-project' });
      await expect(projectSelect).not.toHaveValue('');
    } else {
      await expect(page.locator('.chat-project-name')).toHaveText('fixture-project', {
        timeout: 15_000,
      });
    }

    await expect(page.locator('.chat-project-unselected-hint')).toHaveCount(0);

    const sendBtn = page.getByRole('button', { name: '送信' });
    await expect(sendBtn).toBeVisible({ timeout: 15_000 });
    const describedBy = (await sendBtn.getAttribute('aria-describedby')) ?? '';
    expect(describedBy).not.toContain('chat-project-unselected-hint');
  }

  function expectBoxInsideViewport(
    box: { x: number; y: number; width: number; height: number },
    viewportHeight: number,
  ) {
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewportHeight);
  }

  async function pastePngAttachment(
    textarea: import('@playwright/test').Locator,
    fileName: string,
  ) {
    await textarea.evaluate((el, name) => {
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const binary = atob(pngBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const file = new File([bytes], name, { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, fileName);
  }

  async function pastePngAttachments(
    textarea: import('@playwright/test').Locator,
    count: number,
  ) {
    for (let i = 0; i < count; i++) {
      await pastePngAttachment(textarea, `test-${i + 1}.png`);
    }
  }

  async function readChatPanelMetrics(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
      const panel = document.querySelector('.chat-panel');
      const heightOf = (selector: string) => {
        const el = document.querySelector(selector);
        if (!el) {
          return null;
        }
        const box = el as HTMLElement;
        return {
          offsetHeight: box.offsetHeight,
          clientHeight: box.clientHeight,
        };
      };
      return {
        clientHeight: panel?.clientHeight ?? 0,
        scrollHeight: panel?.scrollHeight ?? 0,
        chatAttachments: heightOf('.chat-attachments'),
        chatAttachmentUnsupported: heightOf('.chat-attachment-unsupported'),
        chatImagePrivacyHint: heightOf('.chat-image-privacy-hint'),
      };
    });
  }

  async function assertControlHitTarget(
    page: import('@playwright/test').Page,
    selector: string,
    label: string,
  ) {
    const hit = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) {
        return { ok: false, reason: 'missing element', hitClassName: null };
      }
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const target = document.elementFromPoint(cx, cy);
      if (!target) {
        return { ok: false, reason: 'no hit', hitClassName: null };
      }
      const ok = el === target || el.contains(target);
      return {
        ok,
        reason: ok ? 'hit' : 'obstructed',
        hitClassName: target.className,
      };
    }, selector);

    console.log(JSON.stringify({ case: 'elementFromPoint', label, ...hit }));
    expect(hit.ok, `${label} obstructed by ${String(hit.hitClassName)}`).toBe(true);
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

  test('chat messages area is readable with a project selected at 375x812', async ({
    page,
  }) => {
    await openChatPanel(page);
    await ensureProjectSelected(page);

    const messagesHeight = await page.locator('.chat-messages').evaluate((el) => {
      return el.getBoundingClientRect().height;
    });

    console.log(
      JSON.stringify({
        case: '375x812-project-selected',
        messagesHeight,
      }),
    );
    expect(messagesHeight).toBeGreaterThanOrEqual(240);
  });

  test('short viewport chat panel has no unreachable clipped region at 375x430', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 430 });
    await openChatPanel(page);
    await ensureProjectSelected(page);

    await expect(page.locator('.chat-messages')).toBeVisible();

    // Poll timeout is below the test timeout (30s) so failures surface measured overflow values.
    await expect
      .poll(
        async () =>
          page.locator('.chat-panel').evaluate((el) => el.scrollHeight - el.clientHeight),
        { timeout: 10_000 },
      )
      .toBeLessThanOrEqual(0);

    const panelMetrics = await page.locator('.chat-panel').evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
    console.log(
      JSON.stringify({
        case: '375x430-panel',
        panelMetrics,
      }),
    );
    expect(panelMetrics.scrollHeight).toBeLessThanOrEqual(panelMetrics.clientHeight);

    const messagesHeight = await page.locator('.chat-messages').evaluate((el) => {
      return el.getBoundingClientRect().height;
    });
    console.log(
      JSON.stringify({
        case: '375x430-messages',
        messagesHeight,
      }),
    );
    expect(messagesHeight).toBeGreaterThanOrEqual(40);
  });

  test('375px width shows privacy hint when image is attached via paste', async ({
    page,
  }) => {
    await openChatPanel(page);
    await ensureProjectSelected(page);

    const textarea = page.locator('.chat-input');
    await expect(textarea).toBeVisible();

    await pastePngAttachment(textarea, 'test.png');

    await expect(page.locator('.chat-attachments')).toBeVisible();

    // Blur so :focus-within does not unclip the hint — paste via evaluate does not focus
    // today, but a future paste flow that focuses the textarea would mask sr-only clip.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const hint = page.locator('.chat-image-privacy-hint');
    await expect(hint).toBeVisible();

    const hintMetrics = await hint.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      position: getComputedStyle(el).position,
    }));
    console.log(JSON.stringify(hintMetrics));
    expect(hintMetrics.height).toBeGreaterThan(10);
    expect(hintMetrics.position).toBe('static');
  });

  // e2e フィクスチャの chat agent は画像添付非対応のため、paste すると常に
  // .chat-attachment-unsupported (約 50.8px、短いビューポート圧縮後 36.6px) が出る。
  // 実ブラウザ (画像送信可) より縦スペースが厳しい — フィクスチャが変われば余裕も変わる。
  test('short viewport keeps chat controls reachable with max image attachments', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 430 });
    await openChatPanel(page);
    await ensureProjectSelected(page);

    const textarea = page.locator('.chat-input');
    await expect(textarea).toBeVisible();

    const baselineMetrics = await readChatPanelMetrics(page);
    console.log(
      JSON.stringify({
        case: '375x430-panel-attachments-0',
        panelMetrics: baselineMetrics,
      }),
    );

    await pastePngAttachment(textarea, 'test-one.png');
    await expect(page.locator('.chat-attachment')).toHaveCount(1);

    const oneAttachmentMetrics = await readChatPanelMetrics(page);
    console.log(
      JSON.stringify({
        case: '375x430-panel-attachments-1',
        panelMetrics: oneAttachmentMetrics,
      }),
    );
    expect(oneAttachmentMetrics.scrollHeight).toBeLessThanOrEqual(
      oneAttachmentMetrics.clientHeight,
    );

    await pastePngAttachments(textarea, 3);
    await expect(page.locator('.chat-attachment')).toHaveCount(4);

    const attachmentNames = page.locator('.chat-attachment-name');
    await expect(attachmentNames).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      const name = attachmentNames.nth(i);
      await expect(name).toBeVisible();
      await expect(name).not.toHaveText(/^\s*$/);
    }

    await expect
      .poll(
        async () =>
          page.locator('.chat-panel').evaluate((el) => el.scrollHeight - el.clientHeight),
        { timeout: 10_000 },
      )
      .toBeLessThanOrEqual(0);

    const fourAttachmentMetrics = await readChatPanelMetrics(page);
    console.log(
      JSON.stringify({
        case: '375x430-panel-attachments-4',
        panelMetrics: fourAttachmentMetrics,
      }),
    );
    expect(fourAttachmentMetrics.scrollHeight).toBeLessThanOrEqual(
      fourAttachmentMetrics.clientHeight,
    );

    await assertControlHitTarget(
      page,
      '.chat-panel-settings-summary',
      'chat settings',
    );
    await assertControlHitTarget(
      page,
      '.chat-thread-switcher-toggle',
      'thread switcher',
    );

    const previewBox = await page.locator('.chat-attachment-preview').first().boundingBox();
    expect(previewBox).not.toBeNull();
    expect(previewBox!.width).toBeGreaterThanOrEqual(20);
    expect(previewBox!.height).toBeGreaterThanOrEqual(20);

    await page.locator('.chat-attachment-remove').first().click();
    await expect(page.locator('.chat-attachment')).toHaveCount(3);
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
