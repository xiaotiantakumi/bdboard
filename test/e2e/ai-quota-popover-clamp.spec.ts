import { expect, test, type Page } from '@playwright/test';

/**
 * `/api/ai-quota` のレスポンス形。正本は web/src/api.ts の AiQuotaDto /
 * AiQuotaProviderDto / AiQuotaMetricDto で、ここはその wire 形だけを写した
 * ローカル定義。e2e は独立した tsc プロジェクト (test/e2e/tsconfig.json) なので
 * web/src からは import しない。
 */
interface AiQuotaFixtureMetric {
  label: string;
  percentRemaining?: number;
  resetAt?: string;
  status?: 'available' | 'exhausted';
}
interface AiQuotaFixtureProvider {
  id: string;
  label: string;
  availability: 'live' | 'manual' | 'unavailable';
  metrics: AiQuotaFixtureMetric[];
  detail?: string;
}
interface AiQuotaFixture {
  state: 'ok';
  fetchedAt: string;
  providers: AiQuotaFixtureProvider[];
}

interface AiQuotaErrorFixture {
  state: 'error';
  message: string;
}

type AiQuotaRouteResponse = AiQuotaFixture | AiQuotaErrorFixture;

const MOBILE_VIEWPORT = { width: 375, height: 812 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const MID_RANGE_520_VIEWPORT = { width: 520, height: 800 };
const MID_RANGE_700_VIEWPORT = { width: 700, height: 800 };
const MID_RANGE_760_VIEWPORT = { width: 760, height: 800 };
const BOUNDS_EPSILON_PX = 0.5;

const AI_QUOTA_FIXTURE: AiQuotaFixture = {
  state: 'ok',
  fetchedAt: '2026-09-11T00:00:00.000Z',
  providers: [
    {
      id: 'agy',
      label: 'Antigravity (Gemini sub)',
      availability: 'live',
      metrics: [
        {
          label: 'GEMINI MODELS Weekly Limit Remaining',
          percentRemaining: 99,
          resetAt: '2026-09-11T06:10:00.000Z',
        },
        { label: 'CLAUDE AND GPT MODELS Five Hour Limit Remaining', status: 'available' },
      ],
    },
    {
      id: 'codex',
      label: 'Codex (ChatGPT sub)',
      availability: 'live',
      metrics: [
        {
          label: 'CODEX Weekly Limit Remaining',
          percentRemaining: 99,
          resetAt: '2026-09-11T06:10:00.000Z',
        },
        { label: 'CODEX Five Hour Limit Remaining', status: 'available' },
      ],
    },
    {
      id: 'claude',
      label: 'Claude Code (claude.ai sub)',
      availability: 'live',
      metrics: [
        {
          label: 'CLAUDE Weekly Limit Remaining',
          percentRemaining: 99,
          resetAt: '2026-09-11T06:10:00.000Z',
        },
        { label: 'CLAUDE Five Hour Limit Remaining', status: 'available' },
      ],
    },
    {
      id: 'cursor',
      label: 'Cursor',
      availability: 'live',
      metrics: [
        {
          label: 'CURSOR Weekly Limit Remaining',
          percentRemaining: 99,
          resetAt: '2026-09-11T06:10:00.000Z',
        },
        { label: 'CURSOR Five Hour Limit Remaining', status: 'available' },
      ],
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      availability: 'live',
      metrics: [
        {
          label: 'GEMINI Weekly Limit Remaining',
          percentRemaining: 99,
          resetAt: '2026-09-11T06:10:00.000Z',
        },
        { label: 'GEMINI Five Hour Limit Remaining', status: 'available' },
      ],
    },
  ],
};

const AI_QUOTA_MANUAL_FIXTURE: AiQuotaFixture = {
  ...AI_QUOTA_FIXTURE,
  providers: [
    ...AI_QUOTA_FIXTURE.providers,
    {
      id: 'manual-x',
      label: 'Manual Provider',
      availability: 'manual',
      detail:
        '数値を自動取得できません。対象サービスのダッシュボードで残量を確認してください。',
      metrics: [],
    },
  ],
};

const AI_QUOTA_ERROR_FIXTURE: AiQuotaErrorFixture = {
  state: 'error',
  message: 'quota fetch failed',
};

async function installAiQuotaRoute(page: Page): Promise<void> {
  await page.route('**/api/ai-quota', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AI_QUOTA_FIXTURE),
    });
  });
}

async function installAiQuotaManualRoute(page: Page): Promise<void> {
  await page.route('**/api/ai-quota', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AI_QUOTA_MANUAL_FIXTURE),
    });
  });
}

async function installSwitchableAiQuotaRoute(
  page: Page,
  getResponse: () => AiQuotaRouteResponse,
): Promise<void> {
  await page.route('**/api/ai-quota', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(getResponse()),
    });
  });
}

// AiQuotaWidget の refetchInterval は5分。offline→online トグルでは再取得できない:
// QueryClient が staleTime: 30_000 を持つ (web/src/main.tsx) ため refetchOnReconnect が
// fresh なクエリを再取得しないから。refetchInterval は staleTime と無関係に発火するので、
// 時計を1周期ぶん進めるのが唯一の確実な再フェッチ手段。
async function advanceToNextQuotaPoll(page: Page): Promise<void> {
  await page.clock.fastForward('05:10');
}

async function openAiQuotaPopover(page: Page): Promise<void> {
  const badge = page.locator('.ai-quota-badge');
  await expect(badge).toBeVisible({ timeout: 15_000 });
  await badge.click();
  await expect(
    page.locator('[role="region"][aria-label="AIクォータ詳細"]'),
  ).toBeVisible();
}

interface ManualNoteDetailMetrics {
  innerWidth: number;
  shift: string;
  inlineShift: string;
  detail: { left: number; right: number };
  summaryRight: number;
  epsilon: number;
}

async function openManualNoteDetail(page: Page): Promise<ManualNoteDetailMetrics> {
  await openAiQuotaPopover(page);
  const summary = page.locator('.ai-quota-note > summary');
  await expect(summary).toBeVisible();
  await summary.click();
  await expect(page.locator('.ai-quota-note-detail')).toBeVisible();

  return page.evaluate((epsilon) => {
    const innerWidth = window.innerWidth;
    const detail = document.querySelector('.ai-quota-note-detail');
    const summaryEl = document.querySelector('.ai-quota-note > summary');
    const detailRect = detail?.getBoundingClientRect();
    const summaryRect = summaryEl?.getBoundingClientRect();
    const shift = detail
      ? getComputedStyle(detail).getPropertyValue('--popover-shift-x').trim()
      : '';
    const inlineShift = detail
      ? (detail as HTMLElement).style.getPropertyValue('--popover-shift-x').trim()
      : '';

    return {
      innerWidth,
      shift,
      inlineShift,
      detail: {
        left: detailRect?.left ?? Number.NaN,
        right: detailRect?.right ?? Number.NaN,
      },
      summaryRight: summaryRect?.right ?? Number.NaN,
      epsilon,
    };
  }, BOUNDS_EPSILON_PX);
}

test.describe('ai quota popover viewport clamp — mobile', () => {
  test.use({
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
  });

  // 修正前 (transform クランプ無し) の実測: popover left=-89.48 / right=248.02 / innerWidth=375。
  // プロバイダ名5行が全て画面外に出ていた (bdboard-hovk の 2026-09-05 実機スイープと一致)。
  // html { overflow-x: hidden } のため横スクロールでも救えない。
  test('375x812: popover and all provider labels stay within the viewport', async ({ page }) => {
    await installAiQuotaRoute(page);
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });
    await openAiQuotaPopover(page);

    const metrics = await page.evaluate((epsilon) => {
      const innerWidth = window.innerWidth;
      const popover = document.querySelector('.ai-quota-popover');
      const labels = Array.from(document.querySelectorAll('.ai-quota-provider-label'));

      const popoverRect = popover?.getBoundingClientRect();
      const labelRects = labels.map((label) => {
        const rect = label.getBoundingClientRect();
        return { id: label.textContent ?? '', left: rect.left, right: rect.right };
      });

      return {
        innerWidth,
        bodyScrollWidth: document.body.scrollWidth,
        popover: popoverRect
          ? { left: popoverRect.left, right: popoverRect.right }
          : null,
        labelRects,
        labelCount: labels.length,
        epsilon,
      };
    }, BOUNDS_EPSILON_PX);

    expect(
      metrics.popover,
      'ai-quota popover must be present after opening',
    ).not.toBeNull();
    expect(
      metrics.labelCount,
      'fixture must render five live provider labels',
    ).toBe(5);

    const popover = metrics.popover!;
    expect(
      popover.left >= -metrics.epsilon && popover.right <= metrics.innerWidth + metrics.epsilon,
      `popover must fit within viewport ` +
        `(left=${popover.left}, right=${popover.right}, innerWidth=${metrics.innerWidth})`,
    ).toBe(true);

    for (const label of metrics.labelRects) {
      expect(
        label.left >= -metrics.epsilon && label.right <= metrics.innerWidth + metrics.epsilon,
        `provider label "${label.id}" must fit within viewport ` +
          `(left=${label.left}, right=${label.right}, innerWidth=${metrics.innerWidth})`,
      ).toBe(true);
    }

    // bodyScrollWidth only grows for rightward overflow; negative left (off-screen left) does not increase it — left-edge clamp is covered by popover/label asserts above.
    expect(
      metrics.bodyScrollWidth <= metrics.innerWidth + metrics.epsilon,
      `page must not overflow horizontally ` +
        `(body.scrollWidth=${metrics.bodyScrollWidth}, innerWidth=${metrics.innerWidth})`,
    ).toBe(true);
  });

  // 修正前は復帰後 left=-89.48 / --popover-shift-x 未設定 に戻っていた
  // （依存配列が [open] だけで、新しい DOM ノードに layout effect が再実行されないため）。
  test('375x812: popover stays clamped after fetch error recovery while open', async ({ page }) => {
    let response: AiQuotaRouteResponse = AI_QUOTA_FIXTURE;
    // clock.install() は必ず goto の前。install 後でないと refetchInterval のタイマーを掴めない。
    await page.clock.install();
    await installSwitchableAiQuotaRoute(page, () => response);
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });
    await openAiQuotaPopover(page);

    const initialMetrics = await page.evaluate((epsilon) => {
      const popover = document.querySelector('.ai-quota-popover');
      const popoverRect = popover?.getBoundingClientRect();
      return {
        left: popoverRect?.left ?? Number.NaN,
        epsilon,
      };
    }, BOUNDS_EPSILON_PX);
    expect(
      initialMetrics.left >= -initialMetrics.epsilon,
      `popover must be clamped before error (left=${initialMetrics.left})`,
    ).toBe(true);

    response = AI_QUOTA_ERROR_FIXTURE;
    await advanceToNextQuotaPoll(page);
    await expect(page.locator('.ai-quota-badge')).toBeHidden({ timeout: 15_000 });

    response = AI_QUOTA_FIXTURE;
    await advanceToNextQuotaPoll(page);
    await expect(
      page.locator('[role="region"][aria-label="AIクォータ詳細"]'),
    ).toBeVisible({ timeout: 15_000 });

    const metrics = await page.evaluate((epsilon) => {
      const innerWidth = window.innerWidth;
      const popover = document.querySelector('.ai-quota-popover');
      const labels = Array.from(document.querySelectorAll('.ai-quota-provider-label'));
      const popoverRect = popover?.getBoundingClientRect();
      const shift = popover
        ? getComputedStyle(popover).getPropertyValue('--popover-shift-x').trim()
        : '';
      const labelRects = labels.map((label) => {
        const rect = label.getBoundingClientRect();
        return { id: label.textContent ?? '', left: rect.left, right: rect.right };
      });

      return {
        innerWidth,
        shift,
        popover: popoverRect
          ? { left: popoverRect.left, right: popoverRect.right }
          : null,
        labelRects,
        labelCount: labels.length,
        epsilon,
      };
    }, BOUNDS_EPSILON_PX);

    expect(metrics.popover, 'popover must reappear after recovery').not.toBeNull();
    expect(metrics.labelCount, 'fixture must render five live provider labels').toBe(5);

    const shiftPx = Number.parseFloat(metrics.shift);
    expect(
      metrics.shift !== '' && metrics.shift !== '0px' && shiftPx > 0,
      `popover must apply a positive horizontal shift after recovery (shift=${metrics.shift})`,
    ).toBe(true);

    const popover = metrics.popover!;
    expect(
      popover.left >= -metrics.epsilon && popover.right <= metrics.innerWidth + metrics.epsilon,
      `popover must fit within viewport after recovery ` +
        `(left=${popover.left}, right=${popover.right}, innerWidth=${metrics.innerWidth}, shift=${metrics.shift})`,
    ).toBe(true);

    for (const label of metrics.labelRects) {
      expect(
        label.left >= -metrics.epsilon && label.right <= metrics.innerWidth + metrics.epsilon,
        `provider label "${label.id}" must fit within viewport after recovery ` +
          `(left=${label.left}, right=${label.right}, innerWidth=${metrics.innerWidth})`,
      ).toBe(true);
    }
  });
});

test.describe('ai quota popover viewport clamp — desktop', () => {
  test.use({
    viewport: DESKTOP_VIEWPORT,
  });

  test('1280x800: popover stays right-aligned without horizontal shift', async ({ page }) => {
    await installAiQuotaRoute(page);
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });
    await openAiQuotaPopover(page);

    const metrics = await page.evaluate((epsilon) => {
      const popover = document.querySelector('.ai-quota-popover');
      const badge = document.querySelector('.ai-quota-badge');
      const popoverRect = popover?.getBoundingClientRect();
      const badgeRect = badge?.getBoundingClientRect();
      const shift = popover
        ? getComputedStyle(popover).getPropertyValue('--popover-shift-x').trim()
        : '';

      return {
        shift,
        popoverRight: popoverRect?.right ?? Number.NaN,
        badgeRight: badgeRect?.right ?? Number.NaN,
        epsilon,
      };
    }, BOUNDS_EPSILON_PX);

    // When the clamp hook is attached it always writes 0px on wide viewports; '' means the hook never ran (e.g. ref detached on remount).
    expect(
      metrics.shift,
      `デスクトップではクランプ装着時に 0px が書き込まれる (shift=${metrics.shift})`,
    ).toBe('0px');
    expect(
      Math.abs(metrics.popoverRight - metrics.badgeRight) <= metrics.epsilon,
      `popover right edge must align with badge right edge ` +
        `(popoverRight=${metrics.popoverRight}, badgeRight=${metrics.badgeRight})`,
    ).toBe(true);
  });
});

function assertManualNoteDetailClampedMidRange(metrics: ManualNoteDetailMetrics): void {
  const { detail, innerWidth, shift, inlineShift, epsilon } = metrics;
  expect(
    detail.left >= -epsilon && detail.right <= innerWidth + epsilon,
    `manual note detail must fit within viewport ` +
      `(left=${detail.left}, right=${detail.right}, innerWidth=${innerWidth}, inlineShift=${inlineShift}, shift=${shift})`,
  ).toBe(true);

  const inlineShiftPx = Number.parseFloat(inlineShift);
  expect(
    inlineShift !== '' && inlineShiftPx > 0,
    `manual note detail must apply a positive horizontal shift in mid-range band ` +
      `(inlineShift=${inlineShift}, shift=${shift}, left=${detail.left}, right=${detail.right}, innerWidth=${innerWidth})`,
  ).toBe(true);
}

test.describe('ai quota note detail viewport clamp — mid-range 520', () => {
  test.use({ viewport: MID_RANGE_520_VIEWPORT });

  test('520x800: manual note detail stays within viewport with positive shift', async ({
    page,
  }) => {
    await installAiQuotaManualRoute(page);
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });
    const metrics = await openManualNoteDetail(page);
    assertManualNoteDetailClampedMidRange(metrics);
  });
});

test.describe('ai quota note detail viewport clamp — mid-range 700', () => {
  test.use({ viewport: MID_RANGE_700_VIEWPORT });

  test('700x800: manual note detail stays within viewport with positive shift', async ({
    page,
  }) => {
    await installAiQuotaManualRoute(page);
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });
    const metrics = await openManualNoteDetail(page);
    assertManualNoteDetailClampedMidRange(metrics);
  });
});

test.describe('ai quota note detail viewport clamp — mid-range 760', () => {
  test.use({ viewport: MID_RANGE_760_VIEWPORT });

  test('760x800: manual note detail stays within viewport with positive shift', async ({
    page,
  }) => {
    await installAiQuotaManualRoute(page);
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });
    const metrics = await openManualNoteDetail(page);
    assertManualNoteDetailClampedMidRange(metrics);
  });
});

test.describe('ai quota note detail viewport clamp — desktop', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('1280x800: manual note detail stays right-aligned without horizontal shift', async ({
    page,
  }) => {
    await installAiQuotaManualRoute(page);
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });
    const metrics = await openManualNoteDetail(page);

    expect(
      metrics.inlineShift,
      `desktop must write 0px when clamp hook is attached (inlineShift=${metrics.inlineShift}, shift=${metrics.shift})`,
    ).toBe('0px');
    expect(
      Math.abs(metrics.detail.right - metrics.summaryRight) <= metrics.epsilon,
      `manual note detail right edge must align with summary right edge ` +
        `(detailRight=${metrics.detail.right}, summaryRight=${metrics.summaryRight}, inlineShift=${metrics.inlineShift}, shift=${metrics.shift})`,
    ).toBe(true);
  });
});

test.describe('ai quota note detail viewport clamp — mobile', () => {
  test.use({
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
  });

  test('375x812: manual note detail stays within viewport without horizontal shift', async ({
    page,
  }) => {
    await installAiQuotaManualRoute(page);
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });
    const metrics = await openManualNoteDetail(page);

    expect(
      metrics.inlineShift,
      `mobile must write 0px when clamp hook is attached (inlineShift=${metrics.inlineShift}, shift=${metrics.shift})`,
    ).toBe('0px');
    expect(
      metrics.detail.left >= -metrics.epsilon &&
        metrics.detail.right <= metrics.innerWidth + metrics.epsilon,
      `manual note detail must fit within viewport ` +
        `(left=${metrics.detail.left}, right=${metrics.detail.right}, innerWidth=${metrics.innerWidth}, inlineShift=${metrics.inlineShift}, shift=${metrics.shift})`,
    ).toBe(true);
  });
});
