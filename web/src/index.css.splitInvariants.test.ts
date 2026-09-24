import { readdirSync, readFileSync } from 'node:fs';
import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * bdboard-2oh4: `index.css` と `styles/` の分割構造を固定する回帰ガード。
 *
 * このテストは index.css 自体が import 行だけで構成されること、styles/ の各 CSS が
 * ちょうど一度 import されること、そしてカスケードに影響する import 順を保証する。
 * CSS の見た目や挙動そのものは検証しない。
 */
const INDEX_CSS_PATH = fileURLToPath(new NodeUrl('./index.css', import.meta.url));
const STYLES_DIR = fileURLToPath(new NodeUrl('./styles', import.meta.url));

/**
 * 将来 `web/src/styles/` を意図的に再構成する PR (bdboard-sso1 epic 配下) では、
 * この定数配列を新しい順序に更新すればよい。意図しない並べ替え (コピペミス・
 * リベース時の衝突解消ミス等) だけを検出するための fixture である。
 */
const EXPECTED_IMPORT_ORDER = [
  'tokens.css', 'base.css', 'header.css', 'base-2.css', 'help.css', 'insights.css', 'settings.css',
  'insights-2.css', 'hygiene.css', 'tokens-2.css', 'hygiene-2.css', 'insights-3.css', 'settings-2.css',
  'ticket-detail.css', 'board.css', 'board-2.css', 'base-3.css', 'ticket-detail-2.css', 'board-3.css',
  'base-4.css', 'hygiene-3.css', 'ticket-detail-3.css', 'board-4.css', 'ticket-detail-4.css',
  'header-2.css', 'settings-3.css', 'help-2.css', 'ticket-detail-5.css', 'sessions.css', 'settings-4.css',
  'board-5.css', 'header-3.css', 'settings-5.css', 'ticket-detail-6.css', 'base-5.css', 'chat.css',
  'chat-2.css', 'responsive.css', 'chat-3.css', 'responsive-2.css', 'header-4.css', 'board-6.css',
  'ticket-detail-7.css', 'board-7.css', 'header-5.css', 'settings-6.css', 'base-6.css',
  'ticket-detail-8.css', 'base-7.css', 'ticket-detail-9.css',
];

interface ParsedIndexCss {
  imports: string[];
  strayLines: string[];
}

function parseIndexCss(source: string): ParsedIndexCss {
  const imports: string[] = [];
  const strayLines: string[] = [];
  const importPattern = /^@import '\.\/styles\/([\w.-]+\.css)';$/;

  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === '') {
      continue;
    }
    const match = line.match(importPattern);
    if (match) {
      imports.push(match[1]);
    } else {
      strayLines.push(line);
    }
  }

  return { imports, strayLines };
}

describe('index.css / web/src/styles split invariants (bdboard-2oh4)', () => {
  const source = readFileSync(INDEX_CSS_PATH, 'utf8');
  const { imports, strayLines } = parseIndexCss(source);
  const styleFiles = readdirSync(STYLES_DIR).filter((name) => name.endsWith('.css'));

  it('index.css は空行と styles の import 行だけで構成される', () => {
    expect(
      strayLines,
      `index.css に import 以外の行があります:\n${strayLines.map((line) => `  ${line}`).join('\n')}`,
    ).toEqual([]);
  });

  it('styles の CSS がすべてちょうど一度だけ import される', () => {
    expect(styleFiles.length, 'styles/ から CSS ファイルを1件も読み取れませんでした').toBeGreaterThan(0);

    const importedSet = new Set(imports);
    const styleFileSet = new Set(styleFiles);
    const orphans = styleFiles.filter((file) => !importedSet.has(file));
    const missing = imports.filter((file) => !styleFileSet.has(file));
    const duplicates = imports.filter((name, index) => imports.indexOf(name) !== index);

    expect(orphans, `import されていない styles の CSS: ${orphans.join(', ')}`).toEqual([]);
    expect(missing, `styles/ に存在しない import 先: ${missing.join(', ')}`).toEqual([]);
    expect(duplicates, `重複している import: ${duplicates.join(', ')}`).toEqual([]);
  });

  it('import の順序が固定 fixture と一致する', () => {
    expect(imports).toEqual(EXPECTED_IMPORT_ORDER);
  });
});
