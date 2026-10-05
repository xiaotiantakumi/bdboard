import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveCssImports } from './testUtils/resolveCssImports';

/**
 * bdboard-494n: 編集欄の「自動の文に戻す」(と確認の 2 つのボタン) は、狭い幅でも押せる大きさにする。
 * 共通の `.btn` は min-height 30px (`.btn-small` は 26px) で、スマホの指には小さい。jsdom は CSS を当てないので、
 * 規則が `issue-reports.css` の狭い幅の `@media` の中にあることを、結合したテキストで確かめる (index.css.* のテストと同じ方式)。
 */
const css = resolveCssImports(resolve(dirname(fileURLToPath(import.meta.url)), 'index.css'));

/** `@media (max-width: 700px) {` の閉じる括弧までの本文 (入れ子の {} を数える)。 */
function narrowMediaBlocks(text: string): string[] {
  const blocks: string[] = [];
  const opener = /@media \(max-width: 700px\) \{/g;
  for (let match = opener.exec(text); match !== null; match = opener.exec(text)) {
    let depth = 1;
    let index = opener.lastIndex;
    while (depth > 0 && index < text.length) {
      if (text[index] === '{') depth += 1;
      else if (text[index] === '}') depth -= 1;
      index += 1;
    }
    blocks.push(text.slice(opener.lastIndex, index - 1));
  }
  return blocks;
}

describe('issue draft reset button touch target (bdboard-494n)', () => {
  it('gives .issue-draft-editor-reset-btn a 44px minimum height inside a narrow-width media query', () => {
    const rule = /\.issue-draft-editor-reset-btn\s*\{[^}]*min-height:\s*44px/;
    expect(narrowMediaBlocks(css).some((block) => rule.test(block))).toBe(true);
  });
});
