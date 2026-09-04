import { expect, test, type Page } from '@playwright/test';

/**
 * Mobile form control font-size regression (bdboard-h4xs.10).
 *
 * Chromium 上で CSS の不変条件（タッチデバイス向けメディアクエリ下で
 * 可視フォーム要素の computed font-size が 16px 以上）を検証している。
 * iOS Safari の実挙動そのもの（オートズームが起きないこと）は保証しない。
 */
// Same value as smoke.spec.ts — from test/fixtures/bd/bdboard.list.json (open ticket
// visible under the default hideDone=true filter; see smoke.spec.ts header comment).
const TICKET_TITLE = 'Fixture ticket bdboard-3tw.8';

const EXCLUDED_INPUT_TYPES = [
  'checkbox',
  'radio',
  'hidden',
  'submit',
  'button',
  'reset',
  'range',
  'color',
  'file',
  'image',
] as const;

interface FormElementViolation {
  tag: string;
  type: string;
  className: string;
  id: string;
  fontSize: string;
}

interface FormElementInspection {
  inspectedCount: number;
  violations: FormElementViolation[];
}

async function inspectFormElementFontSizes(page: Page): Promise<FormElementInspection> {
  return page.evaluate((excludedTypes) => {
    const excluded = new Set<string>(excludedTypes);
    const violations: FormElementViolation[] = [];
    let inspectedCount = 0;

    for (const el of Array.from(document.querySelectorAll('input, textarea, select'))) {
      const tag = el.tagName.toLowerCase();
      let type = '';

      if (tag === 'input') {
        type = (el as HTMLInputElement).type || 'text';
        if (excluded.has(type)) {
          continue;
        }
      }

      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') {
        continue;
      }

      inspectedCount += 1;
      if (parseFloat(style.fontSize) < 16) {
        violations.push({
          tag,
          type,
          className: el.className,
          id: el.id,
          fontSize: style.fontSize,
        });
      }
    }

    return { inspectedCount, violations };
  }, [...EXCLUDED_INPUT_TYPES]);
}

test.describe('mobile input font-size', () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  async function expectAllFormElementsAtLeast16px(
    page: Page,
    context: string,
    minInspected: number,
  ) {
    const { inspectedCount, violations } = await inspectFormElementFontSizes(page);

    expect(
      inspectedCount,
      `${context}: expected at least ${minInspected} form elements, found ${inspectedCount}`,
    ).toBeGreaterThanOrEqual(minInspected);
    expect(
      violations,
      `${context}: form elements with font-size < 16px: ${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  }

  test('visible form controls use at least 16px font-size on touch devices', async ({
    page,
  }) => {
    await page.goto('/');

    const card = page.locator('article').first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    // 実測2（board-filter select + search）。件数が少ないので下限も2のまま。
    await expectAllFormElementsAtLeast16px(page, 'board root', 2);

    const ticketCard = page.locator('article', { hasText: TICKET_TITLE });
    await expect(ticketCard).toBeVisible();
    await ticketCard.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // 実測7（ボード2 + 詳細パネル内 text/search/textarea/select 5）。下限5は約71%で丸ごと消え検知用。
    await expectAllFormElementsAtLeast16px(page, 'ticket detail open', 5);

    const closeBtn = dialog.getByRole('button', { name: '閉じる' });
    await closeBtn.click();
    await expect(dialog).not.toBeVisible();

    await page.getByRole('button', { name: '設定', exact: true }).click();
    // section[aria-label="設定"] はローディング/エラー/コンテンツの3状態すべてにある。
    // コンテンツ状態 (.settings-panel-title) の visible を待ち、エラー状態を素通りしない。
    await expect(page.locator('.settings-panel-title')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('.settings-panel-error')).toHaveCount(0);
    // 実測14（checkbox 等は EXCLUDED_INPUT_TYPES で除外されるため SettingsPanel の input 総数とは一致しない）。
    // 下限11は約8割で設定フォーム群が丸ごと消えたら落ちる程度。
    await expectAllFormElementsAtLeast16px(page, 'settings view', 11);
    // 健全性ビューにはフォーム要素が無くなった（bdboard-2czx で priority 修復 select を削除）ため
    // このビューは検査対象外。この対策が本当に守りたいケース（クラス無しの select
    // = textarea[class] / select[class] 方式で取りこぼしていた形）は、settings view の
    // .settings-panel-add-row 直下の select が引き続きカバーする。

    await page.getByRole('button', { name: '統合', exact: true }).click();
    await expect(card).toBeVisible({ timeout: 15_000 });

    const chatButton = page.getByRole('button', { name: 'チャット' });
    await expect(chatButton).toBeVisible();
    await chatButton.click();

    const chatDialog = page.getByRole('dialog');
    await expect(chatDialog).toBeVisible();

    // 実測5（ボード2 + チャット textarea/agent select/model select 等）。下限4は80%で丸ごと消え検知用。
    await expectAllFormElementsAtLeast16px(page, 'chat panel open', 4);
  });
});
