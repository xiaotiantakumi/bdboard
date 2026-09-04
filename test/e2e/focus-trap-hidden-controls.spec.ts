import { expect, test } from '@playwright/test';

/**
 * CSS で隠した操作子がフォーカストラップの端に居座る問題 (bdboard-77k) を
 * 実ブラウザで確かめる。
 *
 * 実際に壊れている経路: 幅 700px 以下では
 * `.side-panel-resize-handle { display: none }` が効く。このハンドルは
 * `tabIndex={0}` の div で、パネルの見出しより前にある「最初のフォーカス可能
 * 要素」。修正前のトラップはそれを first と見なすので、本当の先頭(閉じる
 * ボタン)から Shift+Tab しても `active === first` が成立せず、
 * preventDefault されない。結果、フォーカスはダイアログの外へ抜ける。
 *
 * なぜ vitest では足りないか: 隠しているのは index.css のメディアクエリで、
 * jsdom はスタイルシートを読まない。ユニットテストはインラインの
 * `display: none` でしか同じ状況を作れず、「この画面が実際に壊れている」ことは
 * この層でしか測れない。
 */
test.describe('focus trap and CSS-hidden controls', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('keeps focus inside the panel when shift-tabbing off the first control', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 5_000 });
    const chatButton = page.getByRole('button', { name: 'チャット' });
    await expect(chatButton).toBeVisible({ timeout: 15_000 });
    await chatButton.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // 前提の確認: ハンドルは DOM には居るが、この幅では表示されていない。
    // getByRole は既定で display:none の要素を拾わない(アクセシビリティ
    // ツリーに載らない)ので、ここは CSS セレクタで DOM に居ることを見る。
    // `includeHidden` で拾わせることもできるが、クラス + 件数 + 不可視の
    // 3点を直接見るほうが、この前提が崩れたときに黙って通らない。
    const handle = dialog.locator('.side-panel-resize-handle');
    await expect(handle).toHaveCount(1);
    await expect(handle).toBeHidden();

    const closeButton = dialog.getByRole('button', { name: '閉じる' });
    await closeButton.focus();
    await expect(closeButton).toBeFocused();

    await page.keyboard.press('Shift+Tab');

    // 端の判定が隠しハンドルに乗っ取られていなければ、末尾へ折り返す。
    const focusStayedInside = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"]');
      return panel !== null && panel.contains(document.activeElement);
    });
    expect(focusStayedInside).toBe(true);
  });
});
