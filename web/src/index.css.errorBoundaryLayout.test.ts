import { readFileSync } from 'node:fs';
import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ErrorBoundary のオーバーレイ表示は 4 つの CSS 宣言の**組**で成立している。
 * どれか 1 行を消すと bdboard-54uh のバグ (アクション行が画面外/クリップされて
 * 復帰ボタンを押せない) がそのまま再発するが、`ErrorBoundary.test.tsx` の DOM 構造
 * テストは jsdom にレイアウトが無いため 4 通りとも緑のまま通る。実測 (実 Chromium,
 * 375x812, 約 40 行のスタックトレース):
 *
 * | 消した宣言 | パネル高 | アクション行 top | 症状 |
 * |---|---:|---:|---|
 * | `.error-boundary-overlay .error-boundary` の max-height | 2250 | 2290 | 画面外 |
 * | 同 display:flex / flex-direction:column | 690 | 2290 | overflow:hidden でクリップ |
 * | `.error-boundary-body` の overflow-y:auto | 690 | 2290 | 同上 |
 * | `.error-boundary-actions` に overflow:hidden を追加 | 690 | 750 | 行が 28px→8px に潰れる |
 *
 * 3 行目までは「消す」方向なので、`vh`/`dvh` の一括置換のような機械的な編集
 * (例: bdboard-qti6) が巻き込みで落としうる。4 行目は逆に「足す」方向で、
 * flex アイテムの自動最小サイズが主軸の overflow が非スクロールのときだけ
 * min-content になる (css-flexbox-1 §4.5) という前提を壊す。
 *
 * そこで CSS を**テキストとして**読み、この 4 点を固定する。実寸ではなく宣言の
 * 存在を見ているだけなので、レイアウトの正しさそのものを保証はしない — それは
 * 上記の実ブラウザ実測が担う。ここが守るのは「一行消して静かに壊す」経路だけ。
 * 読み方は index.css.customProperties.test.ts に合わせている。
 */
function readCss(): string {
  return readFileSync(fileURLToPath(new NodeUrl('./index.css', import.meta.url)), 'utf8');
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * セレクタが完全一致するトップレベル規則の**宣言部**を返す。
 * セレクタは `,` を含まない単純なものだけを想定している (この規則群はすべてそう)。
 * 見つからなければ null を返し、呼び出し側で「規則ごと消えた/改名された」として落とす。
 */
function ruleBody(css: string, selector: string): string | null {
  const source = stripCssComments(css);
  const pattern = new RegExp(
    `(^|[}\\n])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`,
  );
  const match = source.match(pattern);
  return match === null ? null : match[2];
}

describe('index.css — ErrorBoundary オーバーレイのレイアウト契約 (bdboard-54uh)', () => {
  const css = readCss();

  it('パネルは可視高で頭打ちになり、縦積みの flex コンテナで、はみ出しを隠す', () => {
    const body = ruleBody(css, '.error-boundary-overlay .error-boundary');
    expect(body, '.error-boundary-overlay .error-boundary の規則が見つからない').not.toBeNull();

    // max-height が無いとパネルが本文なりに伸び、アクション行が画面外へ出る。
    // vh 版と dvh 版の 2 行があるが、ここでは「頭打ちがある」ことだけを見る
    // (dvh フォールバックの併記そのものは bdboard-68ub / qti6 の担当)。
    expect(body, 'max-height が無いとパネルが本文なりに伸びる').toMatch(/max-height\s*:/);
    expect(body, 'flex コンテナでないと本文だけを縮められない').toMatch(
      /display\s*:\s*flex\b/,
    );
    expect(body, 'column でないと主軸が縦にならず高さの分配が効かない').toMatch(
      /flex-direction\s*:\s*column\b/,
    );
    expect(body, 'overflow:hidden が無いとパネルの角丸から中身がはみ出す').toMatch(
      /overflow\s*:\s*hidden\b/,
    );
  });

  it('スクロールするのは本文コンテナだけ', () => {
    const body = ruleBody(css, '.error-boundary-body');
    expect(body, '.error-boundary-body の規則が見つからない').not.toBeNull();
    // これが無いと本文は縮まず、代わりにアクション行が overflow:hidden でクリップされる。
    expect(body, 'overflow-y:auto が本文を「縮められる側」にしている').toMatch(
      /overflow-y\s*:\s*auto\b/,
    );
  });

  it('title と actions はスクロールコンテナにしない (縮まない側に残す)', () => {
    for (const selector of ['.error-boundary-title', '.error-boundary-actions']) {
      const body = ruleBody(css, selector);
      expect(body, `${selector} の規則が見つからない`).not.toBeNull();
      // auto / scroll / hidden はいずれもスクロールコンテナ化し、自動最小サイズを
      // 0 に落とす = この要素も縮むようになる。visible / clip は非スクロールなので安全。
      expect(
        body,
        `${selector} をスクロールコンテナにすると、パネルは収まったままボタンが潰れる`,
      ).not.toMatch(/overflow(-x|-y)?\s*:\s*(auto|scroll|hidden)\b/);
    }
  });
});
