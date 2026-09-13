import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// docs/ARCHITECTURE.md のポート表は CLAUDE.md から正本として案内され、読み手は表の名前で
// grep する。表の名前が src に実在すること、ポートモジュールが漏れなく載ることを機械的に
// 検査する (bdboard-fz33。先例は src/readme-env-vars.test.ts)。
//
// 既知の限界: ポート名は ports/ 全体の export に照合するので、ポート interface の代わりに
// 同じモジュールの DTO (例: TunnelStartResult) を書いても検出できない。行ごとに「実装の
// 戻り値型がその行のポートか」を束縛する案は、実装が交差型エイリアス経由
// (SqliteChatSessionRepository = ChatSessionRepository & {...}) だったり引数に `{` を含んだり
// するため正規表現では脆く、見送った。

const PORTS_HEADING = /^## ポート一覧/m;
const NEXT_HEADING = /\n#{2,} /;
const EXCLUSION_HEADING = '表に載せないモジュール:';
const EXCLUSION_ITEM = /^- `([^`]+\.ts)` — \S/;
const IDENTIFIER_IN_BACKTICKS = /`([A-Za-z_$][\w$]*)`/g;

export interface DocumentedPorts {
  readonly portNames: ReadonlySet<string>;
  readonly implementationNames: ReadonlySet<string>;
  readonly excludedFiles: ReadonlySet<string>;
  /** 第1列にバッククォート付きの名前が1つも無いデータ行 (黙って読み飛ばさない) */
  readonly rowsWithoutPortName: readonly string[];
  /** 除外リスト内の `- ` 行で「`file.ts` — 理由」の形になっていないもの */
  readonly malformedExclusions: readonly string[];
}

function backtickedIdentifiers(cell: string): string[] {
  return [...cell.matchAll(IDENTIFIER_IN_BACKTICKS)].map((match) => match[1]);
}

/** 「## ポート一覧」の見出し行の直後から、次の `##` / `###` 見出しの手前までを返す。 */
export function extractPortsSection(document: string): string | undefined {
  const start = document.search(PORTS_HEADING);
  if (start === -1) return undefined;
  const headingEnd = document.indexOf('\n', start);
  if (headingEnd === -1) return '';
  const body = document.slice(headingEnd);
  const next = body.search(NEXT_HEADING);
  return next === -1 ? body : body.slice(0, next);
}

export function extractDocumentedPorts(document: string): DocumentedPorts {
  const portNames = new Set<string>();
  const implementationNames = new Set<string>();
  const excludedFiles = new Set<string>();
  const rowsWithoutPortName: string[] = [];
  const malformedExclusions: string[] = [];
  // before → heading(見出しを読んだ) → items(箇条書きの途中) → done(箇条書きが途切れた)
  let exclusionState: 'before' | 'heading' | 'items' | 'done' = 'before';

  for (const line of (extractPortsSection(document) ?? '').split('\n')) {
    if (line.startsWith(EXCLUSION_HEADING)) {
      exclusionState = 'heading';
      continue;
    }
    if (exclusionState === 'heading' || exclusionState === 'items') {
      const item = EXCLUSION_ITEM.exec(line);
      if (item) {
        excludedFiles.add(item[1]);
        exclusionState = 'items';
        continue;
      }
      if (line.startsWith('- ')) {
        malformedExclusions.push(line);
        exclusionState = 'items';
        continue;
      }
      if (line.trim() === '' && exclusionState === 'heading') continue;
      exclusionState = 'done';
    }

    if (!line.startsWith('|') || /^\|\s*(?:-{3}|ポート\s*\|)/.test(line)) continue;
    const cells = line.split('|');
    const ports = backtickedIdentifiers(cells[1] ?? '');
    if (ports.length === 0) rowsWithoutPortName.push(line);
    for (const name of ports) portNames.add(name);
    for (const name of backtickedIdentifiers(cells[2] ?? '')) implementationNames.add(name);
  }

  return { portNames, implementationNames, excludedFiles, rowsWithoutPortName, malformedExclusions };
}

/**
 * 宣言形の export と `export { A, type B as C }` を拾う。`export * from` や `export default` は
 * 拾わないが、拾えなければ「解決できない名前」として落ちる側 (false-fail) なので安全。
 */
export function extractExportedIdentifiers(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:interface|type|class|abstract\s+class|const|let|function\*?|enum)\s+([A-Za-z_$][\w$]*)/g,
  )) names.add(match[1]);
  for (const match of source.matchAll(/\bexport\s+(?:type\s+)?\{([^}]+)\}/g)) {
    for (const specifier of match[1].split(',')) {
      const exported = /([A-Za-z_$][\w$]*)\s*$/.exec(specifier.trim())?.[1];
      if (exported) names.add(exported);
    }
  }
  return names;
}

function isSourceFile(fileName: string): boolean {
  return fileName.endsWith('.ts') && !fileName.endsWith('.test.ts');
}

/** ports/ 直下の非テスト .ts ごとの export (キーはファイル名) */
export function collectPortModuleExports(portsDirectory: string): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(
    fs.readdirSync(portsDirectory)
      .filter(isSourceFile)
      .map((file) => [file, extractExportedIdentifiers(fs.readFileSync(path.join(portsDirectory, file), 'utf8'))]),
  );
}

/** infrastructure/ 配下 (再帰。__tests__ / fixtures を除く) の非テスト .ts の export の和集合 */
export function collectInfrastructureExports(infrastructureDirectory: string): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'fixtures') visit(entryPath);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        for (const name of extractExportedIdentifiers(fs.readFileSync(entryPath, 'utf8'))) names.add(name);
      }
    }
  };
  visit(infrastructureDirectory);
  return names;
}

export function assertArchitecturePortsTable(
  portModules: ReadonlyMap<string, ReadonlySet<string>>,
  infrastructureExports: ReadonlySet<string>,
  documented: DocumentedPorts,
): void {
  const portExports = new Set([...portModules.values()].flatMap((names) => [...names]));
  expect(portModules.size, 'src/application/ports/ の TypeScript ファイルを走査できなかった').toBeGreaterThan(0);
  expect(portExports, 'ポートの export を1件も抽出できなかった。抽出ロジックを確認すること').not.toHaveLength(0);
  expect(infrastructureExports, 'src/infrastructure/ の export を1件も抽出できなかった').not.toHaveLength(0);
  expect(documented.portNames, 'ARCHITECTURE.md のポート表を抽出できなかった').not.toHaveLength(0);
  expect(documented.rowsWithoutPortName, 'ポート表に、第1列にバッククォート付きの名前が無い行がある').toEqual([]);
  expect(documented.malformedExclusions, '除外リストに「- `file.ts` — 理由」の形になっていない行がある').toEqual([]);

  const unresolvedPorts = [...documented.portNames].filter((name) => !portExports.has(name)).sort();
  expect(unresolvedPorts, `ポート表にあるが src/application/ports/ の export に解決できない名前: ${unresolvedPorts.join(', ')}`).toEqual([]);

  const unresolvedImplementations = [...documented.implementationNames]
    .filter((name) => !infrastructureExports.has(name))
    .sort();
  expect(
    unresolvedImplementations,
    `ポート表の実装列にあるが src/infrastructure/ の export に解決できない名前: ${unresolvedImplementations.join(', ')}`,
  ).toEqual([]);

  const coveredFiles = new Set(
    [...portModules]
      .filter(([, names]) => [...names].some((name) => documented.portNames.has(name)))
      .map(([file]) => file),
  );
  const uncovered = [...portModules.keys()]
    .filter((file) => !coveredFiles.has(file) && !documented.excludedFiles.has(file))
    .sort();
  expect(uncovered, `ポート表にも除外リストにも無いモジュール: ${uncovered.join(', ')}`).toEqual([]);

  const staleExclusions = [...documented.excludedFiles]
    .filter((file) => !portModules.has(file) || coveredFiles.has(file))
    .sort();
  expect(staleExclusions, `除外リストが古い、または表と重複しているモジュール: ${staleExclusions.join(', ')}`).toEqual([]);
}

describe('ARCHITECTURE port table', () => {
  it('extracts table names and the exclusion list, stopping at the next heading', () => {
    const sample = [
      '## ポート一覧(`src/application/ports/`)',
      '',
      '| ポート | 実装 | 役割 |',
      '| --- | --- | --- |',
      '| `AlphaPort` / `BetaPort` | `createAlpha` 等(`infrastructure/alpha`) | y |',
      '| 名前なし | `createGamma` | z |',
      '',
      '表に載せないモジュール:',
      '',
      '- `alpha-fakes.ts` — テスト用 fake。',
      '- `beta-fakes.ts` 理由なし',
      '',
      '- `after-list.ts` — 箇条書きが途切れた後なので除外扱いしない。',
      '',
      '### 下位節',
      '',
      '| `SubsectionName` | x | y |',
      '',
      '## 次節',
    ].join('\n');
    expect(extractDocumentedPorts(sample)).toEqual({
      portNames: new Set(['AlphaPort', 'BetaPort']),
      implementationNames: new Set(['createAlpha', 'createGamma']),
      excludedFiles: new Set(['alpha-fakes.ts']),
      rowsWithoutPortName: ['| 名前なし | `createGamma` | z |'],
      malformedExclusions: ['- `beta-fakes.ts` 理由なし'],
    });
    expect(extractDocumentedPorts('### ポート一覧\n\n| `Nope` | x | y |').portNames).toEqual(new Set());
  });

  it('extracts the export forms used by port and infrastructure modules', () => {
    const source = `
      export interface AlphaPort {}
      export type BetaDto = { readonly id: string };
      export class GammaAdapter {}
      export const createDelta = () => undefined;
      export function createEpsilon(): void {}
      export async function createZeta(): Promise<void> {}
      export { internalEta as Eta, type Theta };
      export type { Iota as IotaAlias };
      const notExported = 1;
    `;
    expect(extractExportedIdentifiers(source)).toEqual(new Set([
      'AlphaPort', 'BetaDto', 'GammaAdapter', 'createDelta', 'createEpsilon', 'createZeta', 'Eta', 'Theta', 'IotaAlias',
    ]));
  });

  it('rejects empty scan inputs instead of silently passing', () => {
    const empty: DocumentedPorts = {
      portNames: new Set(),
      implementationNames: new Set(),
      excludedFiles: new Set(),
      rowsWithoutPortName: [],
      malformedExclusions: [],
    };
    expect(() => assertArchitecturePortsTable(new Map(), new Set(), empty)).toThrow();
    expect(() => assertArchitecturePortsTable(
      new Map([['alpha.ts', new Set(['AlphaPort'])]]),
      new Set(['createAlpha']),
      empty,
    )).toThrow();
  });

  it('keeps the ARCHITECTURE port table in sync with real port and infrastructure exports', () => {
    const repositoryRoot = process.cwd();
    const portModules = collectPortModuleExports(path.join(repositoryRoot, 'src/application/ports'));
    const infrastructureExports = collectInfrastructureExports(path.join(repositoryRoot, 'src/infrastructure'));
    const documented = extractDocumentedPorts(fs.readFileSync(path.join(repositoryRoot, 'docs/ARCHITECTURE.md'), 'utf8'));
    assertArchitecturePortsTable(portModules, infrastructureExports, documented);
  });
});
