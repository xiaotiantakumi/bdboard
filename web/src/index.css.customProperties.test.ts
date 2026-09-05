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
  // usePopoverViewportClamp.ts が開いている各ポップオーバー要素の inline style に書く値。
  '--popover-shift-x',
]);

const SCOPED_CUSTOM_PROPERTIES = new Set([
  // .model-stats-table-scroller 上の値を、同要素の ::before / ::after のフェードだけが参照する。
  '--model-stats-fade-color',
  // .detail-panel.chat-panel 上の値を、その子孫の .chat-attachment 系が参照する。
  '--chat-attachment-preview-size',
]);

function collectDefinedCustomProperties(css: string): Set<string> {
  const defined = new Set<string>();
  let blockDepth = 0;
  let topLevelHeader = '';
  let isBareRootBlock = false;
  let directDeclaration = '';

  const collectDirectDeclaration = () => {
    const match = directDeclaration.match(/^\s*(--[\w-]+)\s*:/);
    if (match) {
      defined.add(match[1]);
    }
    directDeclaration = '';
  };

  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];

    if (character === '{') {
      if (blockDepth === 0) {
        // `:root, .foo` は :root にも適用されるが、全体トークンの定義場所としては曖昧なので
        // 数えない。ここでは条件なし・単独の bare `:root` だけを定義の正本にする。
        isBareRootBlock = topLevelHeader.trim() === ':root';
        directDeclaration = '';
        topLevelHeader = '';
      } else if (blockDepth === 1 && isBareRootBlock) {
        // bare :root 内の入れ子 at-rule / rule は条件なしの直接宣言ではない。
        directDeclaration = '';
      }
      blockDepth += 1;
      continue;
    }

    if (character === '}') {
      if (blockDepth === 1 && isBareRootBlock) {
        collectDirectDeclaration();
      }
      blockDepth -= 1;
      if (blockDepth === 0) {
        isBareRootBlock = false;
        directDeclaration = '';
        topLevelHeader = '';
      } else if (blockDepth === 1 && isBareRootBlock) {
        directDeclaration = '';
      }
      continue;
    }

    if (blockDepth === 1 && isBareRootBlock) {
      if (character === ';') {
        collectDirectDeclaration();
      } else {
        directDeclaration += character;
      }
    }

    if (blockDepth === 0) {
      if (character === ';') {
        topLevelHeader = '';
      } else {
        topLevelHeader += character;
      }
    }
  }

  return defined;
}

function collectReferencedCustomProperties(css: string): Set<string> {
  return new Set(
    [...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]),
  );
}

describe('index.css custom properties', () => {
  it('defines every referenced custom property in bare :root or a documented exception', () => {
    const sourceWithoutComments = stripCssComments(cssSource);
    const defined = collectDefinedCustomProperties(sourceWithoutComments);
    const referenced = collectReferencedCustomProperties(sourceWithoutComments);
    const allowedNonRootProperties = new Set([
      ...RUNTIME_CUSTOM_PROPERTIES,
      ...SCOPED_CUSTOM_PROPERTIES,
    ]);
    // フォールバック付き var() も許容しない。未定義参照は固定ライト色のフォールバックを
    // ダークテーマへ持ち込むなどの欠陥を隠すため、定義漏れとして必ず検出する。
    const undefinedProperties = [...referenced]
      .filter(
        (property) =>
          !defined.has(property) && !allowedNonRootProperties.has(property),
      )
      .sort();
    // ランタイム値もスコープ値も、参照がなくなったり bare :root のトークンになった時点で
    // 例外にしておく理由が消える。両方を同じ検査対象にして許可リストの陳腐化を防ぐ。
    const staleAllowedProperties = [...allowedNonRootProperties]
      .filter((property) => !referenced.has(property) || defined.has(property))
      .sort();

    expect(
      undefinedProperties,
      `index.css に bare :root で未定義のカスタムプロパティ参照があります: ${undefinedProperties.join(', ')}。全テーマ・全スコープで使う値は条件なしの :root に定義し、要素スコープまたは実行時書き込みが意図的なら理由付きで許可リストに追加してください。`,
    ).toEqual([]);
    expect(
      staleAllowedProperties,
      `カスタムプロパティ許可リストに不要なエントリがあります: ${staleAllowedProperties.join(', ')}。var() 参照がなくなったか bare :root に定義されたため、許可リストから削除してください。`,
    ).toEqual([]);
  });
});
