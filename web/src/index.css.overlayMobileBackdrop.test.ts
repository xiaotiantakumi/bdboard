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

    // index.css の import 順で styles/ticket-detail-3.css (22番目の @import) の
    // .overlay が結合後 CSS 中で最初に現れる (@media の外)。ファイル名を決め打ちせず
    // 「最初に見つかった .overlay ルール」を対象にし、ルール直前に @media が無いことも
    // 確認して、メディア条件内の override を基底と誤認しないようにする。
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

  it('no .overlay rule anywhere declares an explicit height (present or future)', () => {
    // 上記2件はそれぞれ「最初に見つかったルール」「overscroll-behavior:none を持つ
    // ルール」という特定条件に絞った検証だが、これだと「将来どこか別の @media に
    // .overlay { height: ... } が新設される」回帰を見逃す。ここでは結合後 CSS 中の
    // 全ての .overlay ルールを走査し、height 宣言 (max-height/min-height は対象外) が
    // 一つも無いことを保証する — .overlay は常に position:fixed + inset:0 由来の
    // 高さにのみ従う、という設計不変条件そのもののガード。
    const css = resolveCssImports(fileURLToPath(new NodeUrl(CSS_RELATIVE_PATH, import.meta.url)));
    const rules = overlayRules(css);
    expect(rules.length, '結合後 CSS に .overlay ルールが見つかりません').toBeGreaterThan(0);

    const offenders = rules.flatMap((rule) => {
      const heightDeclarations = rule.body
        .split(';')
        .map((declaration) => declaration.trim())
        .filter((declaration) => /^height\s*:/i.test(declaration));
      if (heightDeclarations.length === 0) {
        return [];
      }
      const excerpt = rule.body.trim().replace(/\s+/g, ' ');
      return [`行 ${lineNumberAt(css, rule.start)}: { ${excerpt} } — ${heightDeclarations.join('; ')}`];
    });

    expect(offenders, offenders.join('\n') || undefined).toEqual([]);
  });
});
