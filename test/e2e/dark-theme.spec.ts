import { expect, test, type JSHandle, type Page } from '@playwright/test';

/*
 * ダークテーマ e2e。方針の全文は test/e2e/README.md「テーマ (light / dark) の見かた」。
 *
 * 前提 (bdboard-rr8m で実測): Playwright の `colorScheme` フィクスチャは
 * node_modules/playwright/lib/index.js の
 *   colorScheme: [({ contextOptions }) => use(contextOptions.colorScheme === undefined ? 'light' : ...)]
 * で **既定 'light'** に解決され、`_combinedContextOptions` 経由で page フィクスチャにも
 * 手書きの browser.newContext() にも back-fill される。つまり明示的に上書きしない限り
 * どのスペックもダークを一度も描画しない。このファイルだけが `test.use({ colorScheme: 'dark' })`
 * でそれを外す。他の 91 件はライトのまま = **描画**としてはライト/ダーク両方が suite 全体で
 * 踏まれる。ただし**コントラスト検査はこのファイル (= ダーク) だけ**で、ライトは見ていない。
 * 同じ掃引をライトに倒すと sub-AA が多数出る。bdboard-rr8m 時点の実測は 20 セレクタで、
 * bdboard-skde がそのうち 3 件 (.lane-count / .filter-chip-active / .filter-chip-clear) を
 * 直したので現在は 17 前後のはずだが、**再測していないので数字は信用しないこと**。
 * ライト側の掃引を e2e に足す話は bdboard-97ib。
 *
 * このアプリのテーマは 2 状態しかない: `:root` (light) と
 * `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) }`。
 * `[data-theme='dark']` という規則は存在せず、`data-theme` を設定するコードもアプリ側に無い
 * (実測: light メディア下で data-theme="dark" を立てても --color-bg は #f2f2f7 のまま)。
 * したがってダークを描画する手段は prefers-color-scheme の emulation だけ。
 */

/** index.css の dark ブロックが定義するトークンの実値。ずれたら気付けるよう直値で持つ。 */
const DARK_BG_TOKEN = '#000000';
const DARK_TEXT_TOKEN = '#f2f2f7';

/**
 * ライトとダークで **同じ値のままが正しい**色。セレクタではなく色の値で持つのは、
 * 同じトークンを使う要素が増えても許可リストを触らずに済ませるため。
 *
 * index.css の色系トークン 42 個のうち両テーマで同値なのは **2 つ**:
 * `--color-text-tertiary` (#8e8e93) と `--color-accent-fg` (#ffffff)。
 * ここに挙げてあるのは前者と .overlay のスクリム (トークンではない直値) だけで、
 * `--color-accent-fg` は入れていない — 現在 web/src/ には `var(--color-accent-fg)` の参照が
 * 1 つも無く (実測)、描画に出ないので掃引に掛からないため。
 * **将来この死にトークンを実際に配線した瞬間、両テーマ同値が正しいにもかかわらず
 * pinned として誤って赤になる。** そのときの直し方は「白 = rgb(255, 255, 255) をここへ足す」
 * ではない (白は他の箇所でも使われうるので、正当な pinned まで一緒に隠してしまう)。
 * 許可リストを値ではなくセレクタで持つ形に作り替えるほうを先に検討すること。
 */
const INTENTIONALLY_THEME_INVARIANT = new Set([
  'rgb(142, 142, 147)', // --color-text-tertiary: #8e8e93 — 両テーマ同値で定義されている
  'rgba(0, 0, 0, 0.4)', // .overlay のモーダルスクリム — 下地を暗くするのが目的なので不変
]);

type KnownSubAA = {
  /** ダークでの実測比率 (macOS Chromium)。floor の出どころ。 */
  readonly measured: number;
  /** これを下回ったら「許容済みの箇所がさらに悪化した」として落とす。 */
  readonly floor: number;
  readonly note: string;
};

/**
 * ダークで WCAG AA (4.5:1) を満たさない既知の箇所と、その**現在値に基づく下限**。
 * 追加するときは必ず bd チケットを立ててここに ID を書く。空にするのが目標。
 * 現在は空。bdboard-skde で 3 件とも解消した。
 *
 * セレクタの集合にして無条件に読み飛ばす形にはしないこと。それだと許可リストに載った
 * セレクタは**いくら悪化しても緑のまま**出荷される (実測: `.lane-count` をダーク限定で
 * #1b1b1d = 約 1.05:1 の事実上不可視にしても 3 テストとも緑だった)。
 * 代わりに両方向を見る:
 *  - floor を下回ったら赤 = 許容済みの箇所のさらなる悪化
 *  - AA を満たすようになったら赤 = このエントリが陳腐化した (許可リストから外せ)
 * 後者が無いと「直したのに許可リストに残り続ける」状態に誰も気付けない。
 *
 * 今後のエントリでは floor を measured より 0.05 ほど下へ丸める。比率は整数 sRGB 2 色だけから
 * 決まる純関数なので、実測は 4 回とも同値で、この 0.05 は「実効背景の合成経路が祖先の構造変更で
 * わずかに変わる」程度しか見込んでいない。AA (4.5) までの隔たりより十分狭くして、実際の悪化を
 * 取り逃さないこと。
 */
const KNOWN_SUB_AA: ReadonlyMap<string, KnownSubAA> = new Map();

type Sample = {
  key: string;
  color: string;
  background: string;
  effectiveBg: [number, number, number] | null;
  borderColors: string[];
  borderWidths: number[];
  fontSize: number;
  fontWeight: number;
  hasOwnText: boolean;
  text: string;
};

/**
 * 渡された要素配列の色を採取する。**位置は落とさず**、採取対象外は null で埋める。
 * ライト/ダークの 2 回の採取を同じ配列 (= 同じ要素オブジェクト) に対して行い、
 * 添字で対応付けられるようにするため。document.querySelectorAll('*') を 2 回叩くと、
 * その間に SSE/ポーリング由来の再描画が 1 要素でも増減した時点で以降の添字が全部ずれる
 * (実測: 445 件中 299 件しか一致しなくなった)。
 *
 * ページ側で完結させる必要があるので (page.evaluate はクロージャを転送しない)
 * ヘルパもこの関数の中に閉じ込めてある。
 */
function readSamples(elements: Element[]): (Sample | null)[] {
  // parseCssColor と同じ規則。page.evaluate はクロージャを転送しないので複製している。
  const parse = (c: string): [number, number, number, number] | null => {
    const rgb = c.match(/^rgba?\(([^)]+)\)$/);
    if (rgb) {
      const p = rgb[1]!.split(/[\s,/]+/).filter((x) => x.length > 0).map(Number);
      if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null;
      return [p[0]!, p[1]!, p[2]!, p[3] === undefined ? 1 : p[3]!];
    }
    const srgb = c.match(/^color\(srgb\s+([^)]+)\)$/);
    if (srgb) {
      const p = srgb[1]!.split(/[\s/]+/).filter((x) => x.length > 0).map(Number);
      if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null;
      return [p[0]! * 255, p[1]! * 255, p[2]! * 255, p[3] === undefined ? 1 : p[3]!];
    }
    return null;
  };
  const over = (fg: [number, number, number, number], bg: [number, number, number]): [number, number, number] => [
    fg[0] * fg[3] + bg[0] * (1 - fg[3]),
    fg[1] * fg[3] + bg[1] * (1 - fg[3]),
    fg[2] * fg[3] + bg[2] * (1 - fg[3]),
  ];
  /** 自分から祖先へ遡り、最初の不透明な背景の上に半透明な背景を順に重ねた実効背景。 */
  const effectiveBg = (el: Element): [number, number, number] | null => {
    const stack: [number, number, number, number][] = [];
    let node: Element | null = el;
    while (node) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c === null) return null;
      if (c[3] > 0) {
        stack.push(c);
        if (c[3] >= 1) break;
      }
      node = node.parentElement;
    }
    const last = stack[stack.length - 1];
    // 不透明な下地が見つからなければキャンバス既定の白ではなく null を返し、呼び出し側で弾く。
    if (last === undefined || last[3] < 1) return null;
    let acc: [number, number, number] = [last[0], last[1], last[2]];
    for (let i = stack.length - 2; i >= 0; i--) acc = over(stack[i]!, acc);
    return acc;
  };

  return elements.map((el, index) => {
    // 再描画で DOM から外れた要素は getComputedStyle が空を返すので比較対象から外す。
    if (!el.isConnected) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const classes = typeof el.className === 'string' && el.className.trim().length > 0
      ? '.' + el.className.trim().split(/\s+/).join('.')
      : '';
    return {
      key: `${index}:${el.tagName.toLowerCase()}${classes}`,
      color: cs.color,
      background: cs.backgroundColor,
      effectiveBg: effectiveBg(el),
      borderColors: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
      borderWidths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(
        (w) => parseFloat(w) || 0,
      ),
      fontSize: parseFloat(cs.fontSize) || 0,
      fontWeight: parseFloat(cs.fontWeight) || 400,
      hasOwnText: Array.from(el.childNodes).some(
        (n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0,
      ),
      text: (el.textContent ?? '').trim().slice(0, 40),
    };
  });
}

/**
 * DOM の変化が quietMs のあいだ止まるまで待つ。
 * 詳細パネルは開いた直後に非同期でデータが届いて再レンダーするので、そこを踏むと
 * 採取済みの要素が DOM から外れて比較対象が痩せる (実測: 445 件中 288 件まで落ちて
 * 空虚化ガードに引っかかった)。固定 sleep ではなく「変化が止まったこと」を待つ。
 */
async function waitForDomQuiet(page: Page, quietMs = 300, timeoutMs = 10_000): Promise<void> {
  await page.evaluate(
    ({ quiet, limit }) =>
      new Promise<void>((resolve, reject) => {
        let quietTimer: ReturnType<typeof setTimeout>;
        const observer = new MutationObserver(() => {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(finish, quiet);
        });
        const finish = (): void => {
          observer.disconnect();
          clearTimeout(hardStop);
          resolve();
        };
        const hardStop = setTimeout(() => {
          observer.disconnect();
          clearTimeout(quietTimer);
          reject(new Error(`DOM did not settle within ${limit}ms`));
        }, limit);
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        quietTimer = setTimeout(finish, quiet);
      }),
    { quiet: quietMs, limit: timeoutMs },
  );
}

/** ページ内に要素配列を確保して返す。以後の採取はすべて同じ配列に対して行う。 */
async function pinElements(page: Page): Promise<JSHandle<Element[]>> {
  return page.evaluateHandle(() => Array.from(document.querySelectorAll('*')));
}

/**
 * getComputedStyle が返す色を [r, g, b, a] (r/g/b は 0..255) にする。
 *
 * `rgb()` / `rgba()` のほかに **`color(srgb r g b / a)`** を扱う必要がある。
 * index.css は `color-mix(in srgb, ...)` を使っており (.header の背景など)、
 * Chromium はその計算値を color(srgb ...) 形式で、しかも成分を **0..1** で返す。
 * 「数値を順に 4 つ拾う」実装だと `color(srgb 1 1 1 / 0.88)` が rgb(1,1,1) = ほぼ黒として
 * 読めてしまい、白いヘッダーが黒扱いになる (実測でヘッダー見出しが 1.02:1 と誤判定された)。
 * 未知の形式は null を返し、呼び出し側で「解決できなかった」として失敗させる。
 */
function parseCssColor(value: string): [number, number, number, number] | null {
  const rgb = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/).filter((x) => x.length > 0).map(Number);
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] === undefined ? 1 : parts[3]!];
  }
  const srgb = value.match(/^color\(srgb\s+([^)]+)\)$/);
  if (srgb) {
    const parts = srgb[1]!.split(/[\s/]+/).filter((x) => x.length > 0).map(Number);
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return [parts[0]! * 255, parts[1]! * 255, parts[2]! * 255, parts[3] === undefined ? 1 : parts[3]!];
  }
  return null;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fg: [number, number, number], bg: [number, number, number]): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** WCAG 2.2 の large text: 24px 以上、または 18.66px 以上かつ bold。 */
function requiredRatio(sample: Sample): number {
  const large = sample.fontSize >= 24 || (sample.fontSize >= 18.66 && sample.fontWeight >= 700);
  return large ? 3 : 4.5;
}

/** クラス部分だけを取り出す (差分比較の許可リストとメッセージ用。先頭の DOM index を落とす)。 */
function selectorOf(key: string): string {
  return key.replace(/^\d+:/, '');
}

/**
 * transition を止める。テーマを切り替えた直後の getComputedStyle は transition の
 * **開始値**を返す。凍結しないと .toggle-btn のように color に 0.15s の transition を持つ
 * 要素で「ライト相当として採った値が実はダークの色」という**測っている対象そのものが違う**
 * 状態になる (ライト/ダークどちらの採取もずれるので値としては食い違い、pinned 検出は
 * すり抜けて緑のまま通ってしまう = 一番たちの悪い壊れ方)。上の突き合わせで
 * .toggle-btn の確定値を直接見ているのは、この凍結が効いていることを毎回確かめるため。
 * prefers-reduced-motion では代替にならない: index.css の reduced-motion ブロックは
 * `*` に transition-duration:0.01ms を当てるだけで transition-property は all のまま残り、
 * かえって transition が無かった要素にまで 1 フレームの遅れを作る (実測済み)。
 */
async function freezeTransitions(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '*,*::before,*::after{transition:none !important;animation:none !important}',
  });
}

/**
 * いま emulate しているテーマでの `--color-text-secondary` の**確定値**を、
 * 使い捨てのプローブ要素経由で計算値 (rgb 文字列) として解決する。
 *
 * 期待値を直値 (`rgb(108, 108, 112)`) で書くと、パレットを触っただけで
 * 「transition が凍結されていない可能性がある」という嘘のエラーになり、
 * 触った人が transition を疑って時間を溶かす。期待値側もトークンから引く。
 *
 * **これは恒真にはならない。** ここで読むのは *新しく生やした* 要素の初期計算値で、
 * 初期スタイルの決定では transition は走らないのでトークンの確定値がそのまま出る。
 * 一方 .toggle-btn は既に描画済みの要素なので、凍結が効いていなければテーマ切り替えの
 * 遷移中の中間色を返す。つまり両者が食い違うのは「凍結が効いていないとき」だけで、
 * 直値で書いていたときと同じ鋭さを保つ (実測でも凍結を外すと落ちる)。
 */
async function settledTextSecondary(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-text-secondary)';
    probe.style.position = 'fixed';
    probe.style.left = '-9999px';
    probe.style.top = '0';
    probe.textContent = '.';
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
}

/** ボードを開き、先頭カードの詳細パネルまで出す (= 実画面を 2 面ぶん描画する)。 */
async function openBoardAndDetail(page: Page): Promise<void> {
  await page.goto('/');
  const firstCard = page.locator('article').first();
  await expect(firstCard).toBeVisible();
  await freezeTransitions(page);
  await firstCard.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await waitForDomQuiet(page);
}

test.describe('dark theme', () => {
  test.use({ colorScheme: 'dark' });

  test('the page is actually rendered in dark — Playwright の既定 light に戻っていない', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('article').first()).toBeVisible();

    const state = await page.evaluate(() => {
      const rootStyle = getComputedStyle(document.documentElement);
      return {
        prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
        bgToken: rootStyle.getPropertyValue('--color-bg').trim(),
        textToken: rootStyle.getPropertyValue('--color-text').trim(),
        bodyBackground: getComputedStyle(document.body).backgroundColor,
      };
    });

    // 3 つとも別経路の確認。media query だけだと CSS 側が反応していなくても通ってしまい、
    // トークンだけだと emulation が効いていない状態を見逃す。
    expect(state.prefersDark).toBe(true);
    expect(state.bgToken).toBe(DARK_BG_TOKEN);
    expect(state.textToken).toBe(DARK_TEXT_TOKEN);
    // トークンが実際に描画へ届いていること (var() の参照切れなら届かない)。
    expect(state.bodyBackground).toBe('rgb(0, 0, 0)');
  });

  test('dark text meets WCAG AA on the board and the ticket detail panel', async ({ page }) => {
    await openBoardAndDetail(page);
    const handle = await pinElements(page);
    const samples = await page.evaluate(readSamples, handle);
    await handle.dispose();

    const textSamples = samples.filter((s): s is Sample => s !== null && s.hasOwnText);
    // 空虚化防止: 掃引対象が消えたら (セレクタ変更・描画失敗) ここで落ちる。
    // 実測値は 245 件なので 150 は十分に余裕のある下限。
    expect(textSamples.length).toBeGreaterThan(150);

    const unparseable: string[] = [];
    const failures: string[] = [];
    // 同じセレクタが複数回現れる (`.lane-count` は 4 個) ので Set で潰す。
    const regressed = new Set<string>();
    const staleAllowances = new Set<string>();

    for (const sample of textSamples) {
      const fgRaw = parseCssColor(sample.color);
      if (fgRaw === null || sample.effectiveBg === null) {
        unparseable.push(`${selectorOf(sample.key)} color=${sample.color} bg=${sample.background}`);
        continue;
      }
      const bg = sample.effectiveBg;
      const fg: [number, number, number] =
        fgRaw[3] < 1
          ? [
              fgRaw[0] * fgRaw[3] + bg[0] * (1 - fgRaw[3]),
              fgRaw[1] * fgRaw[3] + bg[1] * (1 - fgRaw[3]),
              fgRaw[2] * fgRaw[3] + bg[2] * (1 - fgRaw[3]),
            ]
          : [fgRaw[0], fgRaw[1], fgRaw[2]];

      const ratio = contrastRatio(fg, bg);
      const required = requiredRatio(sample);
      const selector = selectorOf(sample.key);

      const known = KNOWN_SUB_AA.get(selector);
      if (known !== undefined) {
        if (ratio >= required) {
          // 直っている。許可リストに残っているほうが嘘なので、外させるために落とす。
          staleAllowances.add(
            `${selector} — ${ratio.toFixed(2)}:1 で要 ${required}:1 を満たしている ` +
              `(登録時 ${known.measured}:1)。${known.note}`,
          );
        } else if (ratio < known.floor) {
          regressed.add(
            `${selector} — ${ratio.toFixed(2)}:1 が下限 ${known.floor}:1 を割った ` +
              `(登録時 ${known.measured}:1, ${sample.fontSize}px/${sample.fontWeight}) ` +
              `color=${sample.color} on rgb(${bg.map(Math.round).join(', ')})`,
          );
        }
        continue;
      }

      if (ratio >= required) continue;

      failures.push(
        `${selector} — ${ratio.toFixed(2)}:1 (要 ${required}:1, ${sample.fontSize}px/${sample.fontWeight}) ` +
          `color=${sample.color} on rgb(${bg.map(Math.round).join(', ')}) text=${JSON.stringify(sample.text)}`,
      );
    }

    // 色が読めない = 掃引が黙って素通りしている状態なので、これも失敗として出す。
    expect(unparseable, `ダークで色を解決できなかった要素:\n${unparseable.join('\n')}`).toEqual([]);
    expect(
      [...regressed].sort(),
      `KNOWN_SUB_AA で許容済みの箇所がさらに悪化している:\n${[...regressed].sort().join('\n')}\n` +
        '許容済みであることは「いくら暗くしてもよい」という意味ではない。' +
        'floor を下げて追認する前に、直せないかを先に検討すること。',
    ).toEqual([]);
    expect(
      [...staleAllowances].sort(),
      `KNOWN_SUB_AA のエントリが陳腐化している (もう AA を満たしている):\n` +
        `${[...staleAllowances].sort().join('\n')}\n` +
        '該当エントリを KNOWN_SUB_AA から削除し、参照している bd チケットを閉じること。',
    ).toEqual([]);
    expect(
      failures,
      `ダークで WCAG AA を満たさない要素:\n${failures.join('\n')}\n` +
        '意図的に許容するなら bd チケットを立てて KNOWN_SUB_AA に追加すること。',
    ).toEqual([]);
  });

  test('colors adapt between light and dark — 片方のテーマに固定された色が無い', async ({ page }) => {
    await openBoardAndDetail(page);

    // 同一 DOM の同じ要素オブジェクトに対して emulation だけを切り替える。
    const handle = await pinElements(page);
    await page.emulateMedia({ colorScheme: 'light' });
    const lightSettledSecondary = await settledTextSecondary(page);
    const light = await page.evaluate(readSamples, handle);
    await page.emulateMedia({ colorScheme: 'dark' });
    const darkSettledSecondary = await settledTextSecondary(page);
    const dark = await page.evaluate(readSamples, handle);
    await handle.dispose();
    expect(light.length).toBe(dark.length);

    // このテスト自身がテーマを切り替えられているかの確認。これが効いていないと
    // 「全部が pinned」に倒れて派手に落ちるが、原因の切り分けを一目で済ませるため明示する。
    const lightBody = light.find((s) => s?.key.endsWith(':body'));
    const darkBody = dark.find((s) => s?.key.endsWith(':body'));
    expect(lightBody?.background).toBe('rgb(242, 242, 247)');
    expect(darkBody?.background).toBe('rgb(0, 0, 0)');

    // body には transition が無いので上の 2 行だけでは「transition が固まっているか」を
    // 確かめられない。.toggle-btn は `color: var(--color-text-secondary)` を
    // `transition: ... color 0.15s ...` 付きで持つ (index.css の .toggle-btn) ので、
    // 採取値がそのトークンの**確定値**になっていることを見て、遷移途中の中間色を
    // 測っていないことを保証する。freezeTransitions を外すとここが中間色になって落ちる。
    const toggleKey = (s: Sample | null): boolean => /:button\.toggle-btn$/.test(s?.key ?? '');
    const lightToggle = light.find(toggleKey);
    const darkToggle = dark.find(toggleKey);
    expect(lightToggle, '.toggle-btn が採取できていない').toBeDefined();
    // 先に「このトークンが両テーマで実際に変わる」ことを確かめる。同値になったら
    // 遷移そのものが起きず、下の 2 行は凍結が効いていてもいなくても通る = 空虚になる。
    expect(
      lightSettledSecondary,
      '--color-text-secondary が両テーマで同値になっており、下の凍結ガードが空虚になっている',
    ).not.toBe(darkSettledSecondary);
    expect(
      lightToggle?.color,
      'transition が凍結されていない (.toggle-btn が --color-text-secondary の確定値になっていない)',
    ).toBe(lightSettledSecondary);
    expect(
      darkToggle?.color,
      'transition が凍結されていない (.toggle-btn が --color-text-secondary の確定値になっていない)',
    ).toBe(darkSettledSecondary);

    const pinned = new Set<string>();
    let observations = 0;
    let compared = 0;

    for (let i = 0; i < light.length; i++) {
      const l = light[i];
      const d = dark[i];
      // 片方で不可視/切り離しになった要素は比較しない。添字は同じ配列由来なので
      // ここで飛ばしても以降の対応付けはずれない。
      if (!l || !d) continue;
      compared++;

      const props: [string, string, string][] = [
        ['color', l.color, d.color],
        ['background-color', l.background, d.background],
      ];
      const sides = ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'];
      for (let s = 0; s < 4; s++) {
        // 幅 0 の border は描画されないので比較しない。
        if ((l.borderWidths[s] ?? 0) === 0) continue;
        props.push([sides[s]!, l.borderColors[s]!, d.borderColors[s]!]);
      }

      for (const [prop, lightValue, darkValue] of props) {
        // 完全に透明なら描画に出ないので比較しない。文字列比較ではなく解析して判定する
        // (color-mix() の結果は 'rgba(0, 0, 0, 0)' ではなく color(srgb ...) 形式で来る)。
        const parsed = parseCssColor(lightValue);
        if (parsed !== null && parsed[3] === 0) continue;
        observations++;
        if (lightValue !== darkValue) continue;
        if (INTENTIONALLY_THEME_INVARIANT.has(lightValue)) continue;
        pinned.add(`${prop}: ${lightValue} — ${selectorOf(l.key)}`);
      }
    }

    // 空虚化防止 その1: 突き合わせできた要素数。実測 445 件なので 300 は十分な下限。
    // 再描画で片側から要素が消えると比較対象が痩せるが、痩せきったら緑ではなくここで落ちる。
    expect(compared).toBeGreaterThan(300);
    // 空虚化防止 その2: 比較した「プロパティの回数」。要素数だけだと
    // props が空 (border 幅 0 かつ透明) でも気付けない。
    // 実測は 675 (macOS Chromium、4 回とも同値)。下限 450 は上の 2 つと同程度の余裕
    // (実測比 1.5 倍。compared が 1.48 倍、textSamples が 1.63 倍) に合わせてある。
    // CI はこの e2e を ubuntu で回すので Linux 側の実測は未知だが、掃引が 1/3 でも
    // 痩せれば (675 → 450 未満) 落ちる幅は残している。以前の 600 は余裕が 11% しか無く、
    // かつコメントの「1000 件超」が事実と食い違っていた。
    expect(observations).toBeGreaterThan(450);

    expect(
      [...pinned].sort(),
      'ライトとダークで同じ色のまま描画されている箇所:\n' +
        [...pinned].sort().join('\n') +
        '\n未定義のカスタムプロパティを var(--x, <固定色>) で参照していないか、' +
        'テーマトークンではなく生の色を書いていないかを疑うこと。' +
        '両テーマで同値が正しいなら INTENTIONALLY_THEME_INVARIANT に理由付きで追加する。',
    ).toEqual([]);
  });
});
