import { readFileSync } from 'node:fs';
import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KIND_LABELS } from './HygienePanel';

/**
 * jsdom 環境ではグローバルの `URL` が jsdom 実装で Node の `URL` とは別物になる。
 * グローバル `URL` で作ったオブジェクトを `readFileSync` に渡すと
 * `TypeError: The URL must be of scheme file` になるため、`node:url` の `URL` を
 * 明示的に使う。CSS を `?raw` で読む手も使えない — vitest は `test.css` が既定
 * false なので `.css` の内容が空文字列になり、ガードが全 kind 欠落を誤検知する。
 */
function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new NodeUrl(relativePath, import.meta.url)),
    'utf8',
  );
}

const cssSource = readSource('../index.css');
const hygienePanelSource = readSource('./HygienePanel.tsx');

/** warning 系の元祖 kind。既定の --badge-stalled-* のままが意図。 */
const INTENTIONALLY_DEFAULT_KINDS = new Set([
  'overdue_defer',
  'stale_epic',
  'stale_in_progress',
  'unblocked_high_priority_idle',
  'stale_pending_decision',
]);

function collectCssKindSelectors(css: string): Set<string> {
  const kinds = new Set<string>();
  const pattern = /\.hygiene-kind-([a-z_]+)/g;
  for (const match of css.matchAll(pattern)) {
    const kind = match[1];
    if (kind !== 'badge') {
      kinds.add(kind);
    }
  }
  return kinds;
}

function collectKindLabelsKeys(): Set<string> {
  return new Set(Object.keys(KIND_LABELS));
}

function collectHardcodedKindLiterals(source: string): Set<string> {
  const kinds = new Set<string>();
  const pattern = /hygiene-kind-([a-z_]+)/g;
  for (const match of source.matchAll(pattern)) {
    const kind = match[1];
    if (kind !== 'badge') {
      kinds.add(kind);
    }
  }
  return kinds;
}

function collectAllExpectedKinds(hygienePanelSource: string): Set<string> {
  const kinds = collectKindLabelsKeys();
  for (const kind of collectHardcodedKindLiterals(hygienePanelSource)) {
    kinds.add(kind);
  }
  return kinds;
}

describe('HygienePanel kind badge colors', () => {
  const cssKinds = collectCssKindSelectors(cssSource);
  const expectedKinds = collectAllExpectedKinds(hygienePanelSource);

  it('defines CSS for every kind except those intentionally using default colors', () => {
    const missing = [...expectedKinds]
      .filter((kind) => !cssKinds.has(kind))
      .filter((kind) => !INTENTIONALLY_DEFAULT_KINDS.has(kind))
      .sort();
    expect(missing).toEqual([]);
  });

  it('does not define CSS for kinds that HygienePanel never emits', () => {
    const dead = [...cssKinds].filter((kind) => !expectedKinds.has(kind)).sort();
    expect(dead).toEqual([]);
  });
});
