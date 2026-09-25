import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveCssImports } from './testUtils/resolveCssImports';

const CSS_RELATIVE_PATH = './index.css';

interface CssRule {
  start: number;
  body: string;
}

/** 結合後 CSS の .overlay ルールを、対応する閉じ波括弧まで取得する。 */
function overlayRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const pattern = /\.overlay\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(css)) !== null) {
    const open = css.indexOf('{', match.index);
    const close = css.indexOf('}', open + 1);
    if (close === -1) {
      continue;
    }
    rules.push({ start: match.index, body: css.slice(open + 1, close) });
    pattern.lastIndex = close + 1;
  }
  return rules;
}

function lineNumberAt(css: string, offset: number): number {
  return css.slice(0, offset).split('\n').length;
}

describe('index.css — mobile overlay covers the backdrop (bdboard-h4xs.25)', () => {
  it('base overlay keeps fixed positioning and inset coverage', () => {
    const css = resolveCssImports(fileURLToPath(new NodeUrl(CSS_RELATIVE_PATH, import.meta.url)));
    const first = overlayRules(css)[0];
    expect(first, '結合後 CSS に .overlay ルールが見つかりません').toBeDefined();
    if (!first) return;

    // index.css の import 順で base.css が先頭付近に展開される。ルール直前に
    // @media が無いことも確認し、メディア条件内の override を基底と誤認しない。
    const preceding = css.slice(Math.max(0, first.start - 500), first.start);
    const excerpt = first.body.trim().replace(/\s+/g, ' ');
    expect(
      preceding,
      `最初の .overlay ルール (行 ${lineNumberAt(css, first.start)}, { ${excerpt} }) の直前500文字内に @media があり、基底ルールと確認できません`,
    ).not.toContain('@media');
    expect(
      first.body,
      `基底 .overlay ルール (行 ${lineNumberAt(css, first.start)}: { ${excerpt} }) に position: fixed; がありません`,
    ).toMatch(/\bposition\s*:\s*fixed\s*;/);
    expect(
      first.body,
      `基底 .overlay ルール (行 ${lineNumberAt(css, first.start)}: { ${excerpt} }) に inset: 0; がありません`,
    ).toMatch(/\binset\s*:\s*0\s*;/);
  });

  it('mobile overlay rule has no explicit height declaration', () => {
    const css = resolveCssImports(fileURLToPath(new NodeUrl(CSS_RELATIVE_PATH, import.meta.url)));
    const rules = overlayRules(css);
    const mobile = rules.find((rule) => /overscroll-behavior\s*:\s*none\s*;/.test(rule.body));
    expect(mobile, '結合後 CSS に overscroll-behavior: none を持つモバイル .overlay ルールが見つかりません').toBeDefined();
    if (!mobile) return;

    const excerpt = mobile.body.trim().replace(/\s+/g, ' ');
    const heightDeclarations = mobile.body
      .split(';')
      .map((declaration) => declaration.trim())
      .filter((declaration) => /^height\s*:/i.test(declaration));
    expect(
      heightDeclarations,
      `モバイル .overlay ルール (行 ${lineNumberAt(css, mobile.start)}: { ${excerpt} }) に height 宣言があります: ${heightDeclarations.join('; ')}`,
    ).toEqual([]);
  });
});
