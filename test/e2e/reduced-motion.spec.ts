import { expect, test, type Locator, type Page } from '@playwright/test';

/** Parse getComputedStyle().transitionDuration (e.g. "0.15s, 0.15s") into seconds. */
function parseTransitionDurations(raw: string): number[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      if (part.endsWith('ms')) {
        return parseFloat(part) / 1000;
      }
      if (part.endsWith('s')) {
        return parseFloat(part);
      }
      return parseFloat(part);
    });
}

async function readTransitionDurations(target: Locator): Promise<number[]> {
  const raw = await target.evaluate((node) => getComputedStyle(node).transitionDuration);
  return parseTransitionDurations(raw);
}

async function waitForBoardAndRefreshButton(page: Page) {
  const card = page.locator('article').first();
  await expect(card).toBeVisible({ timeout: 15_000 });

  const refreshButton = page.getByRole('button', { name: '手動更新' });
  await expect(refreshButton).toBeVisible();
  return refreshButton;
}

test.describe('prefers-reduced-motion: reduce', () => {
  // Playwright 1.62+: reducedMotion lives on BrowserContextOptions, not top-level test options.
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('shortens CSS transition durations on the manual refresh button', async ({ page }) => {
    await page.goto('/');

    const refreshButton = await waitForBoardAndRefreshButton(page);
    const durations = await readTransitionDurations(refreshButton);

    expect(durations.length).toBeGreaterThan(0);
    expect(durations.every((duration) => duration < 0.001)).toBe(true);
  });
});

test.describe('prefers-reduced-motion: no-preference (control)', () => {
  test.use({ contextOptions: { reducedMotion: 'no-preference' } });

  test('keeps original CSS transition durations on the manual refresh button', async ({ page }) => {
    await page.goto('/');

    const refreshButton = await waitForBoardAndRefreshButton(page);
    const durations = await readTransitionDurations(refreshButton);

    expect(durations.length).toBeGreaterThan(0);
    expect(durations.every((duration) => Math.abs(duration - 0.15) < 0.001)).toBe(true);
  });
});
