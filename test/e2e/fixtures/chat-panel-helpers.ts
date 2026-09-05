import { expect, type Locator, type Page } from '@playwright/test';

export async function openChatPanel(page: Page) {
  await page.goto('/');
  await expect(page.locator('.header')).toBeVisible({ timeout: 5_000 });
  const chatButton = page.getByRole('button', { name: 'チャット' });
  await expect(chatButton).toBeVisible({ timeout: 15_000 });
  await chatButton.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function ensureProjectSelected(page: Page) {
  // e2e フィクスチャは2プロジェクト構成 (global-setup.ts) なので
  // #chat-project-select が描画される (ChatPanel.tsx の showProjectSelect)。
  // select 経路が本線。AC1 の「プロジェクト選択済み」は fixture-project を
  // select した状態。.chat-project-name 分岐は後方互換のフォールバック。
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

/**
 * `/api/chat/agents` の応答を実サーバーから取得したうえで availability だけ 'unavailable' に
 * 差し替える。ラベル・model・supportsImages 等は実応答のまま残すので、フィクスチャが実ボードから
 * 乖離しない。`openChatPanel` (page.goto) より**前**に呼ぶこと。
 */
export async function stubAgentsUnavailable(page: Page) {
  await page.route('**/api/chat/agents', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Array<Record<string, unknown>>;
    const patched = body.map((agent) => ({ ...agent, availability: 'unavailable' }));
    await route.fulfill({
      status: response.status(),
      contentType: 'application/json',
      body: JSON.stringify(patched),
    });
  });
}

export async function pastePngAttachment(textarea: Locator, fileName: string) {
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

export async function pastePngAttachments(textarea: Locator, count: number) {
  for (let i = 0; i < count; i++) {
    await pastePngAttachment(textarea, `test-${i + 1}.png`);
  }
}

/**
 * `.chat-messages` は `.chat-panel` 内で唯一の `flex: 1 1 auto; min-height: 0` なので、
 * 固定チャンクが増えるとこれが先に潰れる。clientHeight がそのまま「会話領域の実測高さ」
 * (= あと何 px 増やせるかの実測値)。
 * `scrollHeight <= clientHeight` は溢れの有無しか言わないので、余裕の観測にはこちらを見る
 * (bdboard-iglk レビュー: 余裕 7.9px で破綻した件)。
 * bdboard-7fsw 以降、375×430 で添付時も 40px 以上を CSS で確保する。
 */
export async function readChatPanelMetrics(page: Page) {
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
        scrollHeight: box.scrollHeight,
      };
    };
    return {
      clientHeight: panel?.clientHeight ?? 0,
      scrollHeight: panel?.scrollHeight ?? 0,
      chatMessages: heightOf('.chat-messages'),
      chatInputNotices: heightOf('.chat-input-notices'),
      chatAttachments: heightOf('.chat-attachments'),
      chatAttachmentError: heightOf('.chat-attachment-error'),
      chatAttachmentUnsupported: heightOf('.chat-attachment-unsupported'),
      chatImagePrivacyHint: heightOf('.chat-image-privacy-hint'),
    };
  });
}

/**
 * 祖先の overflow でクリップされた要素も toBeVisible() は可視と判定するため、
 * スクロールコンテナの矩形に収まっているかを自前で見る (bdboard-iglk レビュー D)。
 */
export async function isInsideScrollContainer(
  page: Page,
  containerSelector: string,
  itemSelector: string,
  index: number,
): Promise<boolean> {
  return page.evaluate(
    ({ containerSel, itemSel, idx }) => {
      const container = document.querySelector(containerSel);
      const items = document.querySelectorAll(itemSel);
      const item = items[idx];
      if (!container || !item) {
        return false;
      }
      const c = container.getBoundingClientRect();
      const i = item.getBoundingClientRect();
      return i.top >= c.top - 0.5 && i.bottom <= c.bottom + 0.5;
    },
    { containerSel: containerSelector, itemSel: itemSelector, idx: index },
  );
}

export async function readMessagesHeight(page: Page): Promise<number> {
  return page.locator('.chat-messages').evaluate((el) => el.getBoundingClientRect().height);
}

export async function readNoticesHeight(page: Page): Promise<number> {
  return page.locator('.chat-input-notices').evaluate((el) => el.getBoundingClientRect().height);
}

export async function readNoticesScrollHeight(page: Page): Promise<number> {
  return page.locator('.chat-input-notices').evaluate((el) => el.scrollHeight);
}

export async function waitForFirstAttachmentPreview(page: Page): Promise<Locator> {
  const preview = page.locator('.chat-attachment-preview').first();
  await expect(preview).toBeVisible();
  return preview;
}

export async function readPreviewSize(page: Page): Promise<{ width: number; height: number }> {
  const preview = page.locator('.chat-attachment-preview').first();
  const box = await preview.boundingBox();
  if (!box) {
    throw new Error('.chat-attachment-preview boundingBox() returned null');
  }
  return { width: box.width, height: box.height };
}
