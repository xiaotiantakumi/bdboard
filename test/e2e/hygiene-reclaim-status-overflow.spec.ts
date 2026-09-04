import { expect, test, type Page } from '@playwright/test';

/**
 * モバイル(375x812)で Hygiene の「自動 reclaim 状況」ブロックが横に溢れる回帰を防ぐ
 * (bdboard-z5tv)。
 *
 * global-setup は BDBOARD_RECLAIM_ENABLED=0 のため既定ではこのブロックが描画されない。
 * この spec だけ page.route で /api/lease-health の reclaim を差し替える。
 */

/** web/src/api.ts LeaseHealthDto の wire 形（e2e は web/src を import しない） */
interface StaleLeaseFixture {
  ticketId: string;
  projectId: string;
  leaseExpiresAt: string;
  staleForMs: number;
}

interface ReclaimProjectStatusFixture {
  projectId: string;
  lastRunAt: string | null;
  reclaimedCount: number | null;
  reclaimedCountUnknown: boolean;
  rawSummary: string | null;
  lastError: string | null;
}

interface ReclaimSchedulerStatusFixture {
  enabled: boolean;
  intervalMs: number;
  olderThan: string;
  projects: ReclaimProjectStatusFixture[];
}

interface LeaseHealthFixture {
  staleLeases: StaleLeaseFixture[];
  reclaim: ReclaimSchedulerStatusFixture;
}

interface ReclaimStatusMetrics {
  clientWidth: number;
  scrollWidth: number;
  naturalSingleLineWidth: number;
  textContent: string;
}

/** 空白無し長トークン。折り返し無しなら 1 行幅がコンテナを大幅に超える */
const LONG_LAST_ERROR =
  'bd-stub-unsupported-subcommand-reclaim-overflow-potency-guard-' +
  'x'.repeat(160);

async function installLeaseHealthReclaimRoute(page: Page): Promise<void> {
  await page.route('**/api/lease-health*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as LeaseHealthFixture;

    const requestUrl = new URL(route.request().url());
    const projectsParam = requestUrl.searchParams.get('projects') ?? '';
    const projectIdFromQuery = projectsParam.split(',').filter(Boolean)[0] ?? null;
    const projectId =
      projectIdFromQuery ?? body.staleLeases[0]?.projectId ?? 'fixture-project';

    const patched: LeaseHealthFixture = {
      ...body,
      reclaim: {
        enabled: true,
        intervalMs: 60_000,
        olderThan: '5m',
        projects: [
          {
            projectId,
            lastRunAt: new Date().toISOString(),
            reclaimedCount: 0,
            reclaimedCountUnknown: false,
            rawSummary: null,
            lastError: LONG_LAST_ERROR,
          },
        ],
      },
    };

    await route.fulfill({
      status: response.status(),
      contentType: 'application/json',
      body: JSON.stringify(patched),
    });
  });
}

async function readReclaimStatusMetrics(page: Page): Promise<ReclaimStatusMetrics> {
  return page.evaluate(() => {
    const errorEl = document.querySelector('.hygiene-reclaim-status-error');
    const container = document.querySelector('.hygiene-reclaim-status');
    if (!errorEl || !container) {
      throw new Error('.hygiene-reclaim-status or .hygiene-reclaim-status-error not found');
    }

    const probe = errorEl.cloneNode(true) as HTMLElement;
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.display = 'inline';
    probe.style.width = 'auto';
    probe.style.maxWidth = 'none';
    probe.style.whiteSpace = 'nowrap';
    container.appendChild(probe);
    const naturalSingleLineWidth = probe.getBoundingClientRect().width;
    probe.remove();

    return {
      clientWidth: container.clientWidth,
      scrollWidth: container.scrollWidth,
      naturalSingleLineWidth,
      textContent: container.textContent ?? '',
    };
  });
}

test.describe('hygiene reclaim status overflow', () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test('reclaim status block fits within viewport at 375px with long error text', async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await installLeaseHealthReclaimRoute(page);

    await page.goto('/');
    await page.getByRole('button', { name: '健全性', exact: true }).click();
    await expect(page.locator('.hygiene-reclaim-status')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.hygiene-reclaim-status-error')).toBeVisible({
      timeout: 15_000,
    });

    const metrics = await readReclaimStatusMetrics(page);

    expect(
      metrics.naturalSingleLineWidth,
      `fixture lastError is too short to exercise wrap: natural single-line width ${metrics.naturalSingleLineWidth} must exceed clientWidth ${metrics.clientWidth}`,
    ).toBeGreaterThan(metrics.clientWidth);

    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth,
      innerWidth: window.innerWidth,
    }));

    expect(
      scrollWidth,
      `body scrollWidth (${scrollWidth}) should fit within innerWidth (${innerWidth})`,
    ).toBeLessThanOrEqual(innerWidth);

    expect(
      metrics.textContent,
      'lastError text should remain readable in the reclaim status block',
    ).toContain(LONG_LAST_ERROR);

    expect(
      metrics.scrollWidth,
      `reclaim status scrollWidth (${metrics.scrollWidth}) should fit within clientWidth (${metrics.clientWidth})`,
    ).toBeLessThanOrEqual(metrics.clientWidth);
  });
});
