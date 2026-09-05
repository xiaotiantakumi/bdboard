import { expect, test } from '@playwright/test';

const MOBILE_320_VIEWPORT = { width: 320, height: 568 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const BOUNDS_EPSILON_PX = 0.5;

test.describe('header popovers viewport clamp at 320px (bdboard-oeh5)', () => {
  test.use({ viewport: MOBILE_320_VIEWPORT, isMobile: true, hasTouch: true });

  test('320x568: project-picker / overflow-menu / preset-control popovers stay within viewport', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });

    // project-picker: 実測で唯一 320px ではみ出す (左へ約32px)。修正後は
    // usePopoverViewportClamp が right shift を適用して収まっているはず。
    await page.locator('.project-picker-button').click();
    await expect(page.locator('.project-picker-popover')).toBeVisible();
    const projectPicker = await page.evaluate((epsilon) => {
      const el = document.querySelector('.project-picker-popover');
      const rect = el?.getBoundingClientRect();
      return {
        found: !!rect,
        left: rect?.left ?? Number.NaN,
        right: rect?.right ?? Number.NaN,
        innerWidth: window.innerWidth,
        epsilon,
      };
    }, BOUNDS_EPSILON_PX);
    expect(projectPicker.found, 'project-picker popover must be present').toBe(true);
    expect(
      projectPicker.left >= -projectPicker.epsilon &&
        projectPicker.right <= projectPicker.innerWidth + projectPicker.epsilon,
      `project-picker popover must fit within viewport ` +
        `(left=${projectPicker.left}, right=${projectPicker.right}, innerWidth=${projectPicker.innerWidth})`,
    ).toBe(true);
    // Escape で閉じてから次のポップオーバーを開く（排他制御があるため）。
    await page.keyboard.press('Escape');

    // overflow-menu: 実測では 320px で収まる (shift=0) が、退行しないことを確認する。
    await page.locator('.overflow-menu-button').click();
    await expect(page.locator('.overflow-menu-popover')).toBeVisible();
    const overflowMenu = await page.evaluate((epsilon) => {
      const el = document.querySelector('.overflow-menu-popover');
      const rect = el?.getBoundingClientRect();
      return {
        found: !!rect,
        left: rect?.left ?? Number.NaN,
        right: rect?.right ?? Number.NaN,
        innerWidth: window.innerWidth,
        epsilon,
      };
    }, BOUNDS_EPSILON_PX);
    expect(overflowMenu.found, 'overflow-menu popover must be present').toBe(true);
    expect(
      overflowMenu.left >= -overflowMenu.epsilon &&
        overflowMenu.right <= overflowMenu.innerWidth + overflowMenu.epsilon,
      `overflow-menu popover must fit within viewport ` +
        `(left=${overflowMenu.left}, right=${overflowMenu.right}, innerWidth=${overflowMenu.innerWidth})`,
    ).toBe(true);
    await page.keyboard.press('Escape');

    // preset-control: 実測では 320px で収まる (shift=0) が、退行しないことを確認する。
    await page.locator('.preset-control-button').click();
    await expect(page.locator('.preset-control-popover')).toBeVisible();
    const presetControl = await page.evaluate((epsilon) => {
      const el = document.querySelector('.preset-control-popover');
      const rect = el?.getBoundingClientRect();
      return {
        found: !!rect,
        left: rect?.left ?? Number.NaN,
        right: rect?.right ?? Number.NaN,
        innerWidth: window.innerWidth,
        epsilon,
      };
    }, BOUNDS_EPSILON_PX);
    expect(presetControl.found, 'preset-control popover must be present').toBe(true);
    expect(
      presetControl.left >= -presetControl.epsilon &&
        presetControl.right <= presetControl.innerWidth + presetControl.epsilon,
      `preset-control popover must fit within viewport ` +
        `(left=${presetControl.left}, right=${presetControl.right}, innerWidth=${presetControl.innerWidth})`,
    ).toBe(true);
  });
});

test.describe('header popovers viewport clamp — desktop (bdboard-oeh5)', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('1280x800: popovers stay within viewport; project-picker has no shift', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });

    async function readPopoverClamp(
      buttonSelector: string,
      popoverSelector: string,
    ): Promise<{
      shift: string;
      found: boolean;
      left: number;
      right: number;
      innerWidth: number;
    }> {
      await page.locator(buttonSelector).click();
      await expect(page.locator(popoverSelector)).toBeVisible();
      const result = await page.evaluate(
        ({ sel }) => {
          const el = document.querySelector(sel);
          const rect = el?.getBoundingClientRect();
          const shift = el
            ? getComputedStyle(el).getPropertyValue('--popover-shift-x').trim()
            : '';
          return {
            shift,
            found: !!rect,
            left: rect?.left ?? Number.NaN,
            right: rect?.right ?? Number.NaN,
            innerWidth: window.innerWidth,
          };
        },
        { sel: popoverSelector },
      );
      await page.keyboard.press('Escape');
      return result;
    }

    // project-picker はコンテナ端まで届かないため shift 不要（実測 0px）。
    const projectPicker = await readPopoverClamp(
      '.project-picker-button',
      '.project-picker-popover',
    );
    expect(projectPicker.found, 'project-picker popover must be present').toBe(true);
    expect(projectPicker.shift).toBe('0px');
    expect(
      projectPicker.left >= -BOUNDS_EPSILON_PX &&
        projectPicker.right <= projectPicker.innerWidth + BOUNDS_EPSILON_PX,
      `project-picker popover must fit within viewport ` +
        `(left=${projectPicker.left}, right=${projectPicker.right}, innerWidth=${projectPicker.innerWidth})`,
    ).toBe(true);

    // overflow-menu / preset-control は right:0 / left:0 で .header/.view-toolbar の
    // 20px padding 端に張り付く。ガター天井 POPOVER_VIEWPORT_GUTTER_MAX_PX も 20px で
    // パディングと意図的に一致している（bdboard-s0o7 / bdboard-hovk PR #318）ため、
    // コンテナ端に張り付く 2 種でも shift は 0px のまま。パディングが 20px 未満に変わると
    // 偽陽性シフトが復活しこの assert が落ちる — 結合の腐り検出用（padding > 20px 方向は
    // gutter < padding なのでずれず、落ちなくて正しい）。
    const overflowMenu = await readPopoverClamp(
      '.overflow-menu-button',
      '.overflow-menu-popover',
    );
    expect(overflowMenu.found, 'overflow-menu popover must be present').toBe(true);
    expect(overflowMenu.shift).toBe('0px');
    expect(
      overflowMenu.left >= -BOUNDS_EPSILON_PX &&
        overflowMenu.right <= overflowMenu.innerWidth + BOUNDS_EPSILON_PX,
      `overflow-menu popover must fit within viewport ` +
        `(left=${overflowMenu.left}, right=${overflowMenu.right}, innerWidth=${overflowMenu.innerWidth})`,
    ).toBe(true);

    const presetControl = await readPopoverClamp(
      '.preset-control-button',
      '.preset-control-popover',
    );
    expect(presetControl.found, 'preset-control popover must be present').toBe(true);
    expect(presetControl.shift).toBe('0px');
    expect(
      presetControl.left >= -BOUNDS_EPSILON_PX &&
        presetControl.right <= presetControl.innerWidth + BOUNDS_EPSILON_PX,
      `preset-control popover must fit within viewport ` +
        `(left=${presetControl.left}, right=${presetControl.right}, innerWidth=${presetControl.innerWidth})`,
    ).toBe(true);
  });
});
