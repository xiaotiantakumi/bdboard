import { readFileSync } from 'node:fs';
import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * jsdom のグローバル URL は Node の URL と別実装なので、CSS をファイルとして読むときは
 * node:url の URL を明示する。HygienePanel.badge-colors.test.ts と同じ読み方にする。
 */
function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new NodeUrl(relativePath, import.meta.url)),
    'utf8',
  );
}

const cssSource = readSource('./index.css');

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const RUNTIME_CUSTOM_PROPERTIES = new Set([
  // documentElement へ実行時に書かれる値。useHeaderHeightVar.ts、
  // useLaneStripHeightVar.ts、useBulkBarHeightVar.ts がそれぞれ管理する。
  '--header-height',
  '--lane-strip-height',
  '--bulk-bar-height',
]);

function collectDefinedCustomProperties(css: string): Set<string> {
  return new Set(
    [...css.matchAll(/(^|[;{\s])(--[\w-]+)\s*:/gm)].map(
      (match) => match[2],
    ),
  );
}

function collectReferencedCustomProperties(css: string): Set<string> {
  return new Set(
    [...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]),
  );
}

describe('index.css custom properties', () => {
  it('defines every referenced custom property except documented runtime values', () => {
    const sourceWithoutComments = stripCssComments(cssSource);
    const defined = collectDefinedCustomProperties(sourceWithoutComments);
    const referenced = collectReferencedCustomProperties(sourceWithoutComments);
    // フォールバック付き var() も許容しない。未定義参照は固定ライト色のフォールバックを
    // ダークテーマへ持ち込むなどの欠陥を隠すため、定義漏れとして必ず検出する。
    const undefinedProperties = [...referenced]
      .filter(
        (property) =>
          !defined.has(property) && !RUNTIME_CUSTOM_PROPERTIES.has(property),
      )
      .sort();

    expect(
      undefinedProperties,
      `index.css に未定義のカスタムプロパティ参照があります: ${undefinedProperties.join(', ')}`,
    ).toEqual([]);
  });
});
