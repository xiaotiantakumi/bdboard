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
 * / `test.use({ colorScheme: 'light' })` で明示的にテーマを固定する。他の 91 件はライトの
 * まま = **描画**としてはライト/ダーク両方が suite 全体で踏まれる。
 *
 * コントラスト検査はこのファイルの 2 本の describe (dark theme / light theme) だけが行う。
 * bdboard-rr8m でダーク側の掃引を先に入れ、bdboard-97ib (本チェンジ) でライト側にも同じ
 * 掃引を回すようにした (`runContrastSweep()` を両テーマで共有)。ライト側の実測は 2026-09-05
 * 時点で sub-AA **18 セレクタ** (`KNOWN_SUB_AA_LIGHT` 参照。bdboard-rr8m 時点の 20 件から
 * bdboard-skde が 3 件を直し、本チェンジで disabled ボタン 4 件を WCAG 1.4.3 の対象外として
 * 掃引から除外し、代わりに新規に 1 件 (`.tips-banner-text-body`, クラス付与前は無クラス
 * `span` で他の無クラス span と衝突する危険な許可リストキーだった) を計上した内訳)。
 *
 * `readSamples()` は要素の `opacity` (自身と、実効背景が確定するまでの祖先の累積値) を
 * 前景色の alpha に掛け合わせる。これを入れていないと `opacity` で薄めた前景が
 * 「濃い色のまま」判定されて掃引を素通りする (bdboard-skde の `.filter-chip-clear` が
 * `opacity: 0.85` で実際にこれを踏んだ)。あわせて `:disabled` の要素は掃引から除外する
 * (WCAG 2.2 Understanding SC 1.4.3: 非活性な UI コンポーネントの文字はコントラスト要件の
 * 対象外)。これを入れないと `.btn:disabled { opacity: 0.5 }` が dark 側でも新規に
 * sub-AA として検出され、意図的な非活性表現を退行として誤検知する
 * (実測: light 4.12:1, dark 4.12:1 — どちらも 4.5 未満)。
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
  /** そのテーマでの実測比率 (macOS Chromium)。floor の出どころ。 */
  readonly measured: number;
  /** これを下回ったら「許容済みの箇所がさらに悪化した」として落とす。 */
  readonly floor: number;
  readonly note: string;
};

/**
 * WCAG AA (4.5:1) を満たさない既知の箇所と、その**現在値に基づく下限**。
 * 追加するときは必ず bd チケットを立ててここに ID を書く。空にするのが目標。
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
const KNOWN_SUB_AA_DARK: ReadonlyMap<string, KnownSubAA> = new Map();

/**
 * ライトで WCAG AA (4.5:1) を満たさない既知の箇所。bdboard-97ib で初めて実測
 * (2026-09-05、Chromium 1280x720、board + ticket detail panel、opacity 込みで計算)。
 * bdboard-rr8m 時点の "20 セレクタ" のうち bdboard-skde が 3 件 (`.lane-count` /
 * `.filter-chip-active` / `.filter-chip-clear`) を解消し、本チェンジで disabled ボタン
 * 4 件 (`.btn:disabled { opacity: 0.5 }`) を WCAG 1.4.3 (非活性 UI コンポーネントは対象外)
 * として掃引そのものから除外し、新たに `.tips-banner-text-body` (無クラス `span` だった
 * ものにクラスを付与して初めて拾えるようになった) を計上して、正味 18 件。
 * 棚卸しチケット: bdboard-97ib.1 (このリストを空にするのが受け入れ条件)。
 *
 * floor の丸め方・両方向チェックの理由は KNOWN_SUB_AA_DARK の doc コメントと同じ。
 */
const KNOWN_SUB_AA_LIGHT: ReadonlyMap<string, KnownSubAA> = new Map([
  [
    'button.meta-text.meta-text-btn',
    { measured: 3.22, floor: 3.17, note: 'bdboard-97ib.1: --color-text-tertiary (#8e8e93)' },
  ],
  ['span.lane-chevron', { measured: 3.26, floor: 3.21, note: 'bdboard-97ib.1: --color-text-tertiary (#8e8e93)' }],
  [
    'span.watch-toggle-icon',
    { measured: 3.26, floor: 3.21, note: 'bdboard-97ib.1: --color-text-tertiary (#8e8e93)' },
  ],
  ['div.card-id', { measured: 3.26, floor: 3.21, note: 'bdboard-97ib.1: --color-text-tertiary (#8e8e93)' }],
  [
    'div.detail-field-label',
    { measured: 3.26, floor: 3.21, note: 'bdboard-97ib.1: --color-text-tertiary (#8e8e93)' },
  ],
  [
    'p.tips-banner-label',
    { measured: 3.39, floor: 3.34, note: 'bdboard-97ib.1: --color-accent (#007aff) on tips banner の着色背景' },
  ],
  [
    'span.badge.badge-pending-decision',
    { measured: 3.67, floor: 3.62, note: 'bdboard-97ib.1: --color-accent (#007aff) on badge の着色背景' },
  ],
  [
    'button.status-pill.status-pill-ok',
    { measured: 3.92, floor: 3.87, note: 'bdboard-97ib.1: success 系の前景/背景の組み合わせ' },
  ],
  [
    'span.badge.badge-unblocks',
    { measured: 3.97, floor: 3.92, note: 'bdboard-97ib.1: success 系の前景/背景の組み合わせ' },
  ],
  [
    'button.toggle-btn.active',
    { measured: 4.02, floor: 3.97, note: 'bdboard-97ib.1: --color-accent (#007aff) on #fff' },
  ],
  [
    'button.ticket-id-link',
    { measured: 4.02, floor: 3.97, note: 'bdboard-97ib.1: --color-accent (#007aff) on #fff' },
  ],
  [
    'button.ticket-id-link.markdown-bead-link',
    { measured: 4.02, floor: 3.97, note: 'bdboard-97ib.1: --color-accent (#007aff) on #fff' },
  ],
  [
    'span.badge.badge-p1',
    { measured: 4.11, floor: 4.06, note: 'bdboard-97ib.1: warning 系の前景/背景の組み合わせ' },
  ],
  [
    'span.tips-banner-text-body',
    {
      measured: 4.41,
      floor: 4.36,
      note:
        'bdboard-97ib.1: --color-text-secondary on tips banner 背景。' +
        'AA まで 0.09 しか離れておらず着手コストは低い',
    },
  ],
  [
    'button.toggle-btn',
    {
      measured: 4.49,
      floor: 4.44,
      note:
        'bdboard-97ib.1: --color-text-secondary on #ededef。同じクラスの occurrence が複数あり ' +
        '実効背景の違いで 4.49:1〜4.54:1 に分かれる。最悪値 (4.49:1) を測定値として計上',
    },
  ],
  [
    'span.project-picker-caret',
    { measured: 4.49, floor: 4.44, note: 'bdboard-97ib.1: --color-text-secondary on #ededef。AA まで 0.01' },
  ],
  [
    'button.overflow-menu-button',
    { measured: 4.49, floor: 4.44, note: 'bdboard-97ib.1: --color-text-secondary on #ededef。AA まで 0.01' },
  ],
  [
    'span.preset-control-caret',
    { measured: 4.49, floor: 4.44, note: 'bdboard-97ib.1: --color-text-secondary on #ededef。AA まで 0.01' },
  ],
]);

type Sample = {
  key: string;
  color: string;
  background: string;
  effectiveBg: [number, number, number] | null;
  /**
   * 要素自身から、実効背景が確定する祖先 (effectiveBg が採用する不透明な背景を持つノード) の
   * 手前までの `opacity` の累積値。1 なら opacity の影響なし。コントラスト計算では
   * 前景の alpha にこれを掛け合わせる — `opacity` は要素 (とその子孫) をまとめて
   * 半透明にし、その手前の不透明な背景に対して透けるので、fg 単体の alpha 合成と
   * 数式上は同じ扱いにできる (bdboard-skde の `.filter-chip-clear { opacity: 0.85 }` が
   * これを踏んだ実例: 素の色だけなら light 5.23:1 に見えるが実描画は 4.02:1 前後)。
   */
  opacity: number;
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
  /**
   * 要素自身から、effectiveBg が「不透明な下地」として採用するノードの**手前**までの
   * opacity を掛け合わせる。その下地ノード自身の opacity は含めない — 下地ノードの
   * opacity は「下地とその子孫がまとめて、さらに外側に対してどう透けるか」の話であって、
   * 子孫の前景色とその下地との**局所的な**コントラストには効かない (opacity はグループ
   * 全体を一枚のレイヤーとして描いてから合成するため、レイヤー内部の相対コントラストは
   * 保たれる)。effectiveBg と同じ停止条件で歩くのはこのため。
   */
  const cumulativeOpacity = (el: Element): number => {
    let node: Element | null = el;
    let acc = 1;
    while (node) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg !== null && bg[3] >= 1) break;
      const op = Number(getComputedStyle(node).opacity);
      if (!Number.isNaN(op)) acc *= op;
      node = node.parentElement;
    }
    return acc;
  };

  return elements.map((el, index) => {
    // 再描画で DOM から外れた要素は getComputedStyle が空を返すので比較対象から外す。
    if (!el.isConnected) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
    // WCAG 2.2 Understanding SC 1.4.3: 非活性な UI コンポーネントの文字はコントラスト
    // 要件の対象外。`.btn:disabled { opacity: 0.5 }` はこれに該当し、opacity を
    // コントラスト計算へ織り込むと素通しできなくなる (実測: light/dark とも 4.5 未満)。
    if (el.matches(':disabled')) return null;
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
      opacity: cumulativeOpacity(el),
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

/**
 * コントラスト掃引本体。dark / light の両 describe から同じ実装を呼ぶ
 * (bdboard-97ib でライト側を追加するにあたり、ダーク単体だったテストから抽出した)。
 * `themeLabel` はアサーションメッセージ用 ("ダーク" / "ライト")、`knownSubAA` は
 * そのテーマの許可リスト (`KNOWN_SUB_AA_DARK` / `KNOWN_SUB_AA_LIGHT`)。
 */
async function runContrastSweep(
  page: Page,
  themeLabel: string,
  knownSubAA: ReadonlyMap<string, KnownSubAA>,
): Promise<void> {
  await openBoardAndDetail(page);
  const handle = await pinElements(page);
  const samples = await page.evaluate(readSamples, handle);
  await handle.dispose();

  const textSamples = samples.filter((s): s is Sample => s !== null && s.hasOwnText);
  // 空虚化防止: 掃引対象が消えたら (セレクタ変更・描画失敗) ここで落ちる。
  // 実測値は 241 件 (disabled ボタン 4 件を除外後。bdboard-97ib) なので 150 は
  // 十分に余裕のある下限。light/dark で描画される要素数は同じ。
  expect(textSamples.length).toBeGreaterThan(150);

  const unparseable: string[] = [];
  const failures: string[] = [];
  // 同じセレクタが複数回現れる (`.lane-count` は 4 個) ので Set で潰す。
  const regressed = new Set<string>();
  const staleAllowances = new Set<string>();
  // 許可リストに載っているセレクタは、同じクラスでも背景の違いで occurrence ごとに
  // 比率が変わりうる (実測: `button.toggle-btn` が同一クラスで 4.4874:1 と 4.5428:1 の
  // 2 通りに分かれた — サイドバーの他のトグルと隣接するかどうかで実効背景が変わるため)。
  // occurrence 単位で stale/regressed を判定すると、複数箇所のうち 1 つだけ AA を
  // 満たした瞬間に「陳腐化した」という誤検知になる (他の occurrence はまだ未達なのに)。
  // 必ず**そのセレクタの全 occurrence の中で最悪の比率**を使って一度だけ判定する。
  const knownRatios = new Map<string, { minRatio: number; required: number; known: KnownSubAA }>();

  for (const sample of textSamples) {
    const fgRaw = parseCssColor(sample.color);
    if (fgRaw === null || sample.effectiveBg === null) {
      unparseable.push(`${selectorOf(sample.key)} color=${sample.color} bg=${sample.background}`);
      continue;
    }
    const bg = sample.effectiveBg;
    // opacity を前景の alpha に合成する (Sample.opacity の doc コメント参照)。
    const combinedAlpha = fgRaw[3] * sample.opacity;
    const fg: [number, number, number] =
      combinedAlpha < 1
        ? [
            fgRaw[0] * combinedAlpha + bg[0] * (1 - combinedAlpha),
            fgRaw[1] * combinedAlpha + bg[1] * (1 - combinedAlpha),
            fgRaw[2] * combinedAlpha + bg[2] * (1 - combinedAlpha),
          ]
        : [fgRaw[0], fgRaw[1], fgRaw[2]];

    const ratio = contrastRatio(fg, bg);
    const required = requiredRatio(sample);
    const selector = selectorOf(sample.key);

    const known = knownSubAA.get(selector);
    if (known !== undefined) {
      const existing = knownRatios.get(selector);
      if (existing === undefined || ratio < existing.minRatio) {
        knownRatios.set(selector, { minRatio: ratio, required, known });
      }
      continue;
    }

    if (ratio >= required) continue;

    failures.push(
      `${selector} — ${ratio.toFixed(2)}:1 (要 ${required}:1, ${sample.fontSize}px/${sample.fontWeight}) ` +
        `color=${sample.color} on rgb(${bg.map(Math.round).join(', ')}) text=${JSON.stringify(sample.text)}`,
    );
  }

  for (const [selector, { minRatio, required, known }] of knownRatios) {
    if (minRatio >= required) {
      // 全 occurrence が直っている。許可リストに残っているほうが嘘なので、外させるために落とす。
      staleAllowances.add(
        `${selector} — 最悪でも ${minRatio.toFixed(2)}:1 で要 ${required}:1 を満たしている ` +
          `(登録時 ${known.measured}:1)。${known.note}`,
      );
    } else if (minRatio < known.floor) {
      regressed.add(
        `${selector} — ${minRatio.toFixed(2)}:1 が下限 ${known.floor}:1 を割った ` +
          `(登録時 ${known.measured}:1)。${known.note}`,
      );
    }
  }

  // 色が読めない = 掃引が黙って素通りしている状態なので、これも失敗として出す。
  expect(unparseable, `${themeLabel}で色を解決できなかった要素:\n${unparseable.join('\n')}`).toEqual([]);
  expect(
    [...regressed].sort(),
    `${themeLabel}の許可リストで許容済みの箇所がさらに悪化している:\n${[...regressed].sort().join('\n')}\n` +
      '許容済みであることは「いくら暗くしてもよい」という意味ではない。' +
      'floor を下げて追認する前に、直せないかを先に検討すること。',
  ).toEqual([]);
  expect(
    [...staleAllowances].sort(),
    `${themeLabel}の許可リストのエントリが陳腐化している (もう AA を満たしている):\n` +
      `${[...staleAllowances].sort().join('\n')}\n` +
      '該当エントリを許可リストから削除し、参照している bd チケットを閉じること。',
  ).toEqual([]);
  expect(
    failures,
    `${themeLabel}で WCAG AA を満たさない要素:\n${failures.join('\n')}\n` +
      '意図的に許容するなら bd チケットを立てて許可リストに追加すること。',
  ).toEqual([]);
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
    await runContrastSweep(page, 'ダーク', KNOWN_SUB_AA_DARK);
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

/*
 * bdboard-97ib: コントラスト掃引をライトでも回す。既定のまま (`test.use` を書かない) だと
 * `colorScheme` フィクスチャが 'light' に解決されるので `test.use({ colorScheme: 'light' })`
 * は無くても等価だが、"dark theme" 側と対称にして、既定挙動に依存していることを明示する
 * ために明示的に書いている。フィクスチャの解決はテスト単位ではなく describe 単位で決まるため
 * (上の "dark theme" ブロックとは独立した別の describe として) 実装した — 同じ describe に
 * 両方の test.use を書いても後勝ちで全テストがそちらに揃ってしまう。
 */
test.describe('light theme (contrast sweep)', () => {
  test.use({ colorScheme: 'light' });

  test('light text meets WCAG AA on the board and the ticket detail panel', async ({ page }) => {
    await runContrastSweep(page, 'ライト', KNOWN_SUB_AA_LIGHT);
  });
});
