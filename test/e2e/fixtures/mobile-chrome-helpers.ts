import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

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

/**
 * `.view-toolbar` の非同期コントロールが出揃ったことを確定する (bdboard-ij7g)。
 *
 * 375px 幅では `.view-toolbar-left` / `.view-toolbar-right` が `display: contents` で箱を
 * 潰され、コントロールは `.view-toolbar` という 1 本の折り返し列に流れる。折り返すのは
 * 「右グループ」ではなくこの 1 本の列であり、ヘッダーが 42px 伸びて 203 → 245 になる。
 * セッション数ボタン (`.meta-text-btn`) は同じメディアクエリで `display: none` なのでこの
 * 帯では折り返しに寄与しない。折り返しに効く非同期コントロールは ai-quota 枠 / 手動更新 /
 * チャットボタンである。
 * それぞれ別々の非同期クエリに依存しているので、**最後に届いた 1 つ**が折り返しの引き金になる。
 * `waitForHeaderHeightConvergence` の解説にあるフレーム単位トレースでは、ai-quota 枠が出た
 * あとも 48ms のあいだヘッダーは 203 のままで、チャットボタン (`chatAvailable` =
 * `/api/chat/availability`) が着いて初めて 245 になった。
 *
 * ここで待つのは**存在**であって高さの期待値ではない。ヘッダーが太る/縮む退行は
 * `mobile-header-compact.spec.ts` の `MAX_HEADER_HEIGHT_PX` など名前の付いたアサーションに
 * 落ちる。逆にコントロール自体が消える退行は、無名のタイムアウトではなくここで落ちる。
 */
export async function assertViewToolbarSettled(page: Page): Promise<void> {
  await assertAiQuotaBadgeVisible(page);
  await expect(
    page.locator('.view-toolbar-right').getByRole('button', { name: 'チャット', exact: true }),
    'ツールバーのチャットボタンが描画されていない。/api/chat/availability が unavailable を' +
      '返しているか (e2e では global-setup の BDBOARD_CLAUDE_PATH スタブで available になる)、' +
      'ViewToolbar の描画条件が変わった。このボタンが無い fixture のヘッダーはツールバーが' +
      '1 行に収まって実機より 42px 軽く、予算/可視性アサーションは空振りになる。',
  ).toBeVisible({ timeout: 15_000 });
}

/** モバイルの縦方向を測る前に、フィルタバーが既定どおり折りたたまれていることを確定する。 */
export async function assertBoardFilterBarCollapsed(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /^絞り込み/ });
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.board-filter-panel')).toBeHidden();
}

export interface HeaderHeightConvergence {
  /** 収束時点の `.header` 実測高 (getBoundingClientRect、小数のまま)。 */
  headerHeight: number;
  /** 収束時点の `--header-height` (px 値)。 */
  headerHeightVar: number;
  /**
   * 収束時点の `.view-toolbar` 配下の要素総数 (`querySelectorAll('*').length`)。
   * bdboard-wt89: ai-quota 枠やチャットボタンのように「非表示 (null 描画) → 出現」で
   * 増える非同期コントロールは、高さを動かさなくてもここが変化する。収束判定に
   * 混ぜている理由は下の JSDoc の「3 つ目の非同期コントロール」節を参照。
   */
  toolbarChildCount: number;
  /** 待ち始めてから収束を確認するまでの実測ミリ秒。 */
  stableAfterMs: number;
  /** 最後に高さ (または toolbarChildCount) が動いてから収束判定までの静止時間 (ミリ秒)。 */
  quietMs: number;
  /** 収束判定までに読んだサンプル数 (フレーム数)。 */
  samples: number;
  /** 収束待ちを開始した後に観測した高さ/ツールバー構成の遷移。CI ログ用の証拠。 */
  changes: string[];
}

/** 静止判定の窓 (ミリ秒)。 */
const HEADER_QUIET_WINDOW_MS = 250;
/** 静止判定に必要な最小サンプル数。rAF が絞られて 1〜2 サンプルで窓を跨ぐのを防ぐ。 */
const HEADER_QUIET_MIN_SAMPLES = 4;
/**
 * ブラウザ側ループの 1 周を、rAF が発火しなくても打ち切るための保険 (bdboard-qi3b)。
 * 通常のフレーム間隔 (~16ms @ 60fps) より十分大きく、かつ `HEADER_QUIET_WINDOW_MS` (250ms) や
 * 10s デッドラインよりずっと小さい値として選んだ — 健全経路では rAF が先に解決するので
 * この値そのものが収束の速さに影響することはなく、rAF が完全に止まった異常系でだけ効く。
 */
const RAF_FALLBACK_MS = 50;

/**
 * ヘッダー高が動かなくなるまで静止時間で待つ。
 *
 * ## 旧実装が取りこぼしていたもの (bdboard-ij7g)
 *
 * 旧実装は `--header-height` と `.header` 実測の**一致**だけを見ていた。`--header-height` は
 * `useHeaderHeightVar` が `ceil(.header の実測高)` を ResizeObserver 経由で書き戻す値なので、
 * 一致はレイアウトが静止していればどの高さでも成立する。つまり「ヘッダーがまだ最終形でない
 * 状態」を収束と判定できてしまう。bdboard-4ij6 の実装中に一度だけ出た
 * `header=203 / maxScrollY=288` はこれで、実際 bdboard-ij7g の作業中にも再現した。
 *
 * ## 203 の正体 (実測トレースで確定させた。チケット記載の推定とは違う)
 *
 * `.view-toolbar` は折り返す。375px 幅では `.view-toolbar-left` / `.view-toolbar-right` が
 * `display: contents` で箱を潰され、コントロールは `.view-toolbar` という 1 本の折り返し列に
 * 流れる。折り返すのは「右グループ」ではなくこの 1 本の列である。セッション数ボタン
 * (`.meta-text-btn`) は同じメディアクエリで `display: none` なのでこの帯では折り返しに寄与せず、
 * 折り返しに効く非同期コントロールは ai-quota 枠 / 手動更新 / チャットボタンである。最後に
 * 届いた 1 つが 42px (203 → 245) の引き金になる。
 * ページ読み込み直後のフレーム単位トレース (macOS Chromium 375x812) は
 *
 *     t=129.6ms  header=203  ツールバー右 = [セッション, 更新中…]
 *     t=145.3ms  header=203  ai-quota 枠が出現 — **まだ 1 行のままで高さは変わらない**
 *     t=179.1ms  header=203  更新中… → 手動更新
 *     t=193.4ms  header=245  チャットボタンが出現 → ここで初めて 2 行に折り返す
 *
 * この列挙は DOM 上の存在であって可視要素ではない (セッション数ボタンは 375px では
 * `display: none` なので折り返しには寄与しない)。
 *
 * つまり 203 は「ai-quota 枠の描画前」ではなく「**ツールバーがまだ 2 行に折り返していない**」
 * 状態。枠の描画は 42px を動かす**必要**条件ではあるが引き金ではなく、引き金は最後に届いた
 * 非同期コントロール (この回は `chatAvailable` に依存するチャットボタン) だった。
 * `mobile-header-compact.spec.ts:67-77` の「枠の有無で 42px」は定常状態どうしの比較としては
 * 正しく、この観察と矛盾しない (枠が無ければチャットボタンが来ても 1 行に収まる)。
 *
 * ## 2 段構えにする理由
 *
 * ヘッダーの最終高は「ヘッダー内の非同期コントロールが**全部**出揃ったか」で決まる。
 * 静止時間だけで待つ案は実際に穴が空くことを実験で確認した: `/api/chat/availability` を
 * 800ms 遅らせると、ヘッダーは 203 のまま静止し続けるので、どんな静止窓もその手前で
 * 「収束した」と答えてしまう (窓を伸ばしても遅延を伸ばせば同じ)。よって静止時間は単独では
 * 判定に使えない。逆に目印の列挙だけでは、次に非同期コントロールが増えたときに穴が空く。
 * そこで両方を重ねる:
 *
 * 1. `assertViewToolbarSettled` — 折り返しに効く既知の非同期コントロール (ai-quota 枠と
 *    チャットボタン) が出揃ったことを**名前の付いたアサーション**で確定させる。ここが
 *    決定論を担う。コントロールが出ない退行は、この待ちの無名タイムアウトではなく
 *    そのアサーションのメッセージとして落ちる。
 * 2. その後 rAF ごとに `.header` 実測と `--header-height` を読み、両者が一致したうえで
 *    `HEADER_QUIET_WINDOW_MS` のあいだ 1 度も動かないこと。1 で列挙していない将来の
 *    非同期コントロールに対する保険で、bdboard-huvu
 *    (`board-filter-missing-label.spec.ts` の `waitForMissingStyleStability`) と同じ
 *    「フレーム間の同一性だけを見る」形。上のトレースで最後の 2 つの変化は 14ms 差、
 *    枠とチャットボタンは 48ms 差なので、250ms は実測の 5 倍以上の余裕がある。
 *
 * **期待するヘッダー高の数値 (245 等) は待ち条件に一切書かない。** 書くと本物の退行が
 * 「タイムアウト」として出てしまい、`mobile-header-compact.spec.ts` の `MAX_HEADER_HEIGHT_PX`
 * のような名前付きアサーションで落ちなくなる。
 *
 * ## 3 つ目の非同期コントロールに対する保険 (bdboard-wt89)
 *
 * 2 のループは `.header` の高さと `--header-height` の一致だけでなく、`.view-toolbar` 配下の
 * 要素総数 (`toolbarChildCount`) も一緒に静止判定へ混ぜている。ai-quota 枠・チャットボタンは
 * どちらも「非表示 (null 描画) → 出現」という増え方をするので、`assertViewToolbarSettled` が
 * 名前で知っている 2 つ以外に**将来 3 つ目の非同期コントロールが `.view-toolbar` に増えても**、
 * その出現がこの静止窓のあいだに起きればここで捕まる — 高さを動かさない (折り返しを
 * 誘発しない) 追加であっても、child count は変わるので取りこぼさない。
 *
 * **ただし解決していない穴が 1 つ残る**: この仕組みは「静止窓の中で起きた変化」しか
 * 検出できない。3 つ目のコントロールの到着そのものが `HEADER_QUIET_WINDOW_MS` の静止判定が
 * 成立したあと (＝収束を返したあと) にずれ込めば、当然ここでは捕まらない。これは
 * `assertViewToolbarSettled` の許可リスト方式と同じ「まだ始まっていない非同期処理は待てない」
 * 制約であり、根本的に解消するにはチケット本文が挙げるもう一方の案 (`.view-toolbar` の
 * 描画をゲートするネットワーク境界を列挙して待つ) が要る。今回はコストの低い保険として
 * 後者ではなくこちらを採用した — 本番相当の変化 (要素の出現/消滅) を直接見るぶん、
 * 高さ変化を経由する既存の仕組みより取りこぼしにくいが、万能ではない。
 *
 * ## rAF が発火しない場合の保険 (bdboard-qi3b)
 *
 * 旧実装はループの折り返しを `requestAnimationFrame` だけに依存していた。rAF が完全に
 * 止まると (Playwright の chromium 起動スイッチは背景タブでの抑制を無効化しているため
 * 実際に踏む確率は低いが) ループ先頭の `timeoutMs` デッドライン判定が二度と評価されず、
 * 丁寧に組み立てた `samples=`/`changes=[...]` 付きの失敗メッセージではなく素の 60s テスト
 * タイムアウトで落ちる。`RAF_FALLBACK_MS` (50ms) を rAF と `Promise.race` させることで、
 * rAF が止まっていてもループは高々 50ms 周期で回り続け、10s デッドラインを確実に評価する。
 * 健全経路では rAF (~16ms) が先に解決するため、この保険は普段の収束速度に影響しない。
 */
export async function waitForHeaderHeightConvergence(
  page: Page,
  message =
    'ヘッダー高が静止しない (--header-height と .header 実測高が一致したまま動かなくならない)。' +
    'レーンストリップ sticky top / scroll-padding-top のずれ原因。',
): Promise<HeaderHeightConvergence> {
  await assertViewToolbarSettled(page);

  return page.evaluate(
    async ({ timeoutMs, quietWindowMs, minQuietSamples, rafFallbackMs, failureMessage }) => {
      const startedAt = performance.now();
      // rAF と `rafFallbackMs` の setTimeout を race させる (bdboard-qi3b)。rAF だけに依存すると
      // rAF が止まったときにこの promise が解決せず、下の while の `timeoutMs` デッドライン
      // 判定が二度と評価されない。健全経路では rAF (~16ms) が先に解決するので通常の収束速度は
      // 変わらない。
      const nextFrameOrTimeout = () =>
        new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          requestAnimationFrame(finish);
          setTimeout(finish, rafFallbackMs);
        });
      type Sample = { headerHeight: number; headerHeightVar: number; toolbarChildCount: number };
      const sample = (): Sample | null => {
        const header = document.querySelector('.header');
        const toolbar = document.querySelector('.view-toolbar');
        if (!header || !toolbar) {
          return null;
        }
        const headerHeightVarStr = getComputedStyle(document.documentElement)
          .getPropertyValue('--header-height')
          .trim();
        const headerHeightVar = headerHeightVarStr.endsWith('px')
          ? Number.parseFloat(headerHeightVarStr)
          : Number.NaN;
        if (!Number.isFinite(headerHeightVar)) {
          return null;
        }
        return {
          headerHeight: header.getBoundingClientRect().height,
          headerHeightVar,
          // bdboard-wt89: `.view-toolbar` 配下の要素総数。ai-quota 枠やチャットボタンは
          // 「非表示 (null 描画) → 出現」で増えるので、高さを動かさない追加でもここで検出できる。
          toolbarChildCount: toolbar.querySelectorAll('*').length,
        };
      };

      const since = () => Math.round((performance.now() - startedAt) * 100) / 100;
      const changes: string[] = [];
      let previous: Sample | null = null;
      let lastChangeAt = performance.now();
      let samples = 0;
      let quietSamples = 0;

      while (performance.now() - startedAt < timeoutMs) {
        const current = sample();
        samples += 1;

        const changed =
          current === null ||
          previous === null ||
          current.headerHeight !== previous.headerHeight ||
          current.headerHeightVar !== previous.headerHeightVar ||
          current.toolbarChildCount !== previous.toolbarChildCount;
        if (changed) {
          lastChangeAt = performance.now();
          quietSamples = 0;
          if (current !== null) {
            changes.push(`h=${current.headerHeight},tb=${current.toolbarChildCount}@${since()}`);
          }
        } else {
          quietSamples += 1;
        }
        previous = current;

        const quietMs = performance.now() - lastChangeAt;
        if (
          current !== null &&
          Math.abs(current.headerHeightVar - Math.ceil(current.headerHeight)) <= 1 &&
          quietMs >= quietWindowMs &&
          quietSamples >= minQuietSamples
        ) {
          return {
            headerHeight: current.headerHeight,
            headerHeightVar: current.headerHeightVar,
            toolbarChildCount: current.toolbarChildCount,
            stableAfterMs: since(),
            quietMs: Math.round(quietMs * 100) / 100,
            samples,
            changes,
          };
        }

        await nextFrameOrTimeout();
      }

      const lastSeen =
        previous === null
          ? '.header/.view-toolbar または --header-height が読めなかった'
          : `headerHeight=${previous.headerHeight}, --header-height=${previous.headerHeightVar}, ` +
            `toolbarChildCount=${previous.toolbarChildCount}`;
      throw new Error(
        `${failureMessage} (samples=${samples}, ${lastSeen}, changes=[${changes.join(', ')}])`,
      );
    },
    {
      timeoutMs: 10_000,
      quietWindowMs: HEADER_QUIET_WINDOW_MS,
      minQuietSamples: HEADER_QUIET_MIN_SAMPLES,
      rafFallbackMs: RAF_FALLBACK_MS,
      failureMessage: message,
    },
  );
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

/**
 * CI ログから測定値を grep で拾うための固定プレフィクス (bdboard-ij7g)。
 *
 * 予算アサーションのメッセージは**失敗時にしか**出ないので、Linux CI の実測値が
 * 一度も記録されないまま「余裕を厚めに取る」しかない状態が続いていた。成功時にも
 * 1 行 JSON で出しておけば、ジョブのログを
 *
 *     grep -o 'MOBILE_SCROLL_RESIDUAL_MEASUREMENT=.*' <log>
 *
 * で拾って macOS 実測と突き合わせ、予算を両プラットフォームの実測を上回る最小値へ
 * 締め直せる (bdboard-ij7g ラウンド 2)。1 行 JSON なのは GitHub Actions のログが
 * 行単位でしか畳めないため。
 */
export const RESIDUAL_MEASUREMENT_LOG_PREFIX = 'MOBILE_SCROLL_RESIDUAL_MEASUREMENT=';

/**
 * 「ユーザーが消せない」残差 = maxScrollY から Tips と絞り込みバーの実測高を引いた残り。
 * モデル上は `header + filterBarMarginBottom - 172` になる。
 * mobile-page-scroll-residual.spec.ts の 2 つ目の予算と同じ量。
 * アサーション対象は生値であり、丸めは表示側だけで行う。
 */
export function nonDismissibleResidualPx(m: ResidualMetrics): number {
  return m.maxScrollY - m.tipsBanner - m.boardFilterBar;
}

/**
 * 残差モデル `maxScrollY = header + tips + filterBarBox - 172` の予測値。
 * 実測と並べて出しておくと、Linux でモデルのどの項がずれたのかがログだけで分かる。
 */
export function modelMaxScrollYPx(m: ResidualMetrics): number {
  return (
    Math.round(
      (m.header + m.tipsBanner + m.boardFilterBar + m.boardFilterBarMarginBottom - 172) * 100,
    ) / 100
  );
}

/**
 * 測定値を**成功時にも**残す。`console.log` の 1 行 JSON (CI ログ用) と
 * `testInfo.attach` の整形 JSON (HTML レポート用) の両方に出す。
 *
 * `label` は 1 つの spec が複数回測るときの区別 (例: tips を閉じる前/後)。
 * `extra` にはその spec 固有の量 (予算、カード位置など) を足せる。
 */
export async function reportResidualMeasurement(
  label: string,
  m: ResidualMetrics,
  extra: Record<string, number | string | boolean | null> = {},
): Promise<void> {
  const info = test.info();
  const payload = {
    spec: path.basename(info.file),
    test: info.title,
    project: info.project.name,
    platform: process.platform,
    label,
    header: m.header,
    tips: m.tipsBanner,
    filterBar: m.boardFilterBar,
    filterBarMarginBottom: m.boardFilterBarMarginBottom,
    maxScrollY: m.maxScrollY,
    nonDismissibleResidual: Math.round(nonDismissibleResidualPx(m) * 100) / 100,
    modelMaxScrollY: modelMaxScrollYPx(m),
    viewportHeight: m.viewportHeight,
    laneIndicatorStrip: m.laneIndicatorStrip,
    lane: m.lane,
    ...extra,
  };
  console.log(`${RESIDUAL_MEASUREMENT_LOG_PREFIX}${JSON.stringify(payload)}`);
  await info.attach(`residual-measurement-${label}`, {
    body: JSON.stringify(payload, null, 2),
    contentType: 'application/json',
  });
}
