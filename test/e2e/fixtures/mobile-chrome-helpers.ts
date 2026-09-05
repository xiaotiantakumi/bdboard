import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, type Page } from '@playwright/test';

/**
 * `/api/ai-quota` のレスポンス形。正本は web/src/api.ts の AiQuotaDto 系で、ここはその
 * wire 形だけを写したローカル定義 (e2e は独立 tsc プロジェクトなので web/src から import しない)。
 * ai-quota-popover-clamp.spec.ts と同じ写し方。
 */
export interface AiQuotaFixtureMetric {
  label: string;
  percentRemaining?: number;
  resetAt?: string;
  status?: 'available' | 'exhausted';
}
export interface AiQuotaFixtureProvider {
  id: string;
  label: string;
  availability: 'live' | 'manual' | 'unavailable';
  metrics: AiQuotaFixtureMetric[];
}
export interface AiQuotaFixture {
  state: 'ok';
  fetchedAt: string;
  providers: AiQuotaFixtureProvider[];
}

// live プロバイダーが 1 つでもあれば .ai-quota-badge は描画される (AiQuotaWidget.tsx)。
// バッジのラベルは `AIクォータ NN%使用` 固定長なので、プロバイダー数を増やしても
// ヘッダー高さは変わらない (増えるのはポップオーバー内だけ)。
export const AI_QUOTA_FIXTURE: AiQuotaFixture = {
  state: 'ok',
  fetchedAt: '2026-09-11T00:00:00.000Z',
  providers: [
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
  ],
};

export async function installAiQuotaRoute(page: Page): Promise<void> {
  await page.route('**/api/ai-quota', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AI_QUOTA_FIXTURE),
    });
  });
}

export async function assertAiQuotaBadgeVisible(page: Page): Promise<void> {
  await expect(
    page.locator('.ai-quota-badge'),
    'AI クォータ枠が描画されていない。/api/ai-quota の route 差し替えが効いていないか、' +
      'AiQuotaWidget の描画条件が変わった。この枠が無い fixture の header は実機より 42px 軽く、' +
      '予算/可視性アサーションは空振りになる。',
  ).toBeVisible({ timeout: 15_000 });
}

/** モバイルの縦方向を測る前に、フィルタバーが既定どおり折りたたまれていることを確定する。 */
export async function assertBoardFilterBarCollapsed(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /^絞り込み/ });
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.board-filter-panel')).toBeHidden();
}

/** --header-height が .header 実測に追いつくまで待つ (AiQuotaWidget 描画後 1 フレーム遅延)。 */
export async function waitForHeaderHeightConvergence(
  page: Page,
  message =
    '--header-height が .header の実測高に追いつかない。' +
    'レーンストリップ sticky top / scroll-padding-top のずれ原因。',
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const header = document.querySelector('.header');
          if (!header) {
            return Number.POSITIVE_INFINITY;
          }
          const headerHeight = header.getBoundingClientRect().height;
          const headerHeightVarStr = getComputedStyle(document.documentElement)
            .getPropertyValue('--header-height')
            .trim();
          const headerHeightVar = headerHeightVarStr.endsWith('px')
            ? Number.parseFloat(headerHeightVarStr)
            : Number.NaN;
          if (!Number.isFinite(headerHeightVar)) {
            return Number.POSITIVE_INFINITY;
          }
          return Math.abs(headerHeightVar - Math.ceil(headerHeight));
        }),
      {
        message,
        timeout: 10_000,
      },
    )
    .toBeLessThanOrEqual(1);
}

/** Tips の原本。web/src/tipsContent.ts と同じ docs/help-content.json を直接読む。 */
export interface HelpTipFixture {
  id: string;
  title: string;
  description: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const HELP_TIPS: HelpTipFixture[] = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'docs/help-content.json'), 'utf8'),
) as HelpTipFixture[];
export const TIP_COUNT = HELP_TIPS.length;

export interface WorstCaseTipMeasurement {
  index: number;
  bannerHeight: number;
  heights: number[];
}

interface TipTextFixture {
  title: string;
  description: string;
}

/** ブラウザ上で各 Tips 文言を差し替え、バナー高さが最大になる index を返す。 */
export async function findWorstCaseTipIndex(page: Page): Promise<WorstCaseTipMeasurement> {
  const tipTexts: TipTextFixture[] = HELP_TIPS.map(({ title, description }) => ({
    title,
    description,
  }));
  return page.evaluate((tipsData) => {
    const banner = document.querySelector('.tips-banner');
    if (!banner) {
      throw new Error('.tips-banner not found');
    }

    const sourceRect = banner.getBoundingClientRect();
    const clone = banner.cloneNode(true) as HTMLElement;
    clone.style.position = 'absolute';
    clone.style.visibility = 'hidden';
    clone.style.left = '0';
    clone.style.top = '0';
    clone.style.width = `${sourceRect.width}px`;
    banner.parentElement?.insertBefore(clone, banner.nextSibling);

    const strong = clone.querySelector('.tips-banner-text strong');
    const span = clone.querySelector('.tips-banner-text span');
    if (!strong || !span) {
      clone.remove();
      throw new Error('.tips-banner-text strong/span not found');
    }

    const heights: number[] = [];
    let maxIndex = 0;
    let maxHeight = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < tipsData.length; i += 1) {
      strong.textContent = tipsData[i].title;
      span.textContent = tipsData[i].description;
      const height = clone.getBoundingClientRect().height;
      heights.push(height);
      if (height > maxHeight) {
        maxHeight = height;
        maxIndex = i;
      }
    }

    clone.remove();
    return { index: maxIndex, bannerHeight: maxHeight, heights };
  }, tipTexts);
}

/**
 * TipsBanner の初期 index を決定論的に固定する。
 * Math.floor(Math.random() * tipCount) === index になるよう (index + 0.5) / tipCount を返す。
 *
 * この spec では preset 生成やパネル履歴トークン生成が走らないため、Math.random を定数化しても
 * 他機能への副作用はない (global-setup へ波及させないのは addInitScript をテスト内に閉じるため)。
 * この前提が崩れたら pin を TipsBanner 専用の注入に切り替えること。
 */
export async function pinTipsBannerRandom(page: Page, index: number, tipCount: number): Promise<void> {
  await page.addInitScript(({ pinnedIndex, tipCount }) => {
    Math.random = () => (pinnedIndex + 0.5) / tipCount;
  }, { pinnedIndex: index, tipCount });
}

/**
 * 375x812 のモバイル縦方向を「ページ側スクロール残差 (maxScrollY)」とその内訳で測る。
 *
 * 残差のモデルは mobile-page-scroll-residual.spec.ts の冒頭に書いてある:
 *   maxScrollY = header + tipsBanner + boardFilterBarBox - 172
 * `boardFilterBarBox` は border-box 高 + margin-bottom。getBoundingClientRect().height は
 * margin を含まないので、`boardFilterBar` と `boardFilterBarMarginBottom` を別々に返す
 * (畳んで 4px / 展開して 8px。index.css の `.board-filter-bar` と
 * `:has(.board-filter-toggle[aria-expanded='false'])`)。この 4px の差が、展開時だけ
 * 実測の定数項が 168 ではなく 164 に見える理由そのもの。
 */
export interface ResidualMetrics {
  maxScrollY: number;
  viewportHeight: number;
  header: number;
  tipsBanner: number;
  boardFilterBar: number;
  boardFilterBarMarginBottom: number;
  laneIndicatorStrip: number;
  lane: number;
}

export async function measureResidual(page: Page): Promise<ResidualMetrics> {
  return page.evaluate(() => {
    const px = (n: number) => Math.round(n * 100) / 100;
    const heightOf = (selector: string): number => {
      const el = document.querySelector(selector);
      return el ? px(el.getBoundingClientRect().height) : 0;
    };
    const marginBottomOf = (selector: string): number => {
      const el = document.querySelector(selector);
      return el ? px(Number.parseFloat(getComputedStyle(el).marginBottom) || 0) : 0;
    };
    const root = document.documentElement;
    return {
      // clientHeight はレイアウトビューポート (縦スクロールバーぶんを含まない) なので
      // innerHeight より「実際に scrollTo できる上限」に忠実。モバイルエミュレーションでは
      // スクロールバーが無く両者は一致するが、定義として正しいほうを使う。
      maxScrollY: px(root.scrollHeight - root.clientHeight),
      viewportHeight: root.clientHeight,
      header: heightOf('.header'),
      tipsBanner: heightOf('.tips-banner'),
      boardFilterBar: heightOf('.board-filter-bar'),
      boardFilterBarMarginBottom: marginBottomOf('.board-filter-bar'),
      laneIndicatorStrip: heightOf('.lane-indicator-strip'),
      lane: heightOf('.lanes-row .lane'),
    };
  });
}

export function describeResidualMetrics(m: ResidualMetrics): string {
  return (
    `maxScrollY=${m.maxScrollY}, viewportHeight=${m.viewportHeight}, ` +
    `header=${m.header}, tips=${m.tipsBanner}, ` +
    `filterBar=${m.boardFilterBar}(+${m.boardFilterBarMarginBottom} margin), ` +
    `laneStrip=${m.laneIndicatorStrip}, lane=${m.lane}`
  );
}
