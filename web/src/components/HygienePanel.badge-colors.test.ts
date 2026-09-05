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

/** WCAG 2.1 AA 通常テキストの最小コントラスト比。 */
const MIN_CONTRAST = 4.5;

/** warning 系の元祖 kind。既定の --badge-stalled-* のままが意図。 */
const INTENTIONALLY_DEFAULT_KINDS = new Set([
  'overdue_defer',
  'stale_epic',
  'stale_in_progress',
  'unblocked_high_priority_idle',
  'stale_pending_decision',
]);

type Rgb = { r: number; g: number; b: number; a: number };

function parseCssColor(s: string): Rgb {
  const trimmed = s.trim();
  const hex = trimmed.match(/^#([0-9a-fA-F]{6})$/);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return {
      r: (n >> 16) & 0xff,
      g: (n >> 8) & 0xff,
      b: n & 0xff,
      a: 1,
    };
  }
  const rgb = trimmed.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/,
  );
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] !== undefined ? Number(rgb[4]) : 1,
    };
  }
  throw new Error(`unsupported CSS color: ${s}`);
}

function compositeOver(fg: Rgb, opaqueBg: Rgb): Rgb {
  const a = fg.a;
  return {
    r: Math.round(fg.r * a + opaqueBg.r * (1 - a)),
    g: Math.round(fg.g * a + opaqueBg.g * (1 - a)),
    b: Math.round(fg.b * a + opaqueBg.b * (1 - a)),
    a: 1,
  };
}

function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** 波括弧の対応を数えて @media (prefers-color-scheme: dark) の中身を連結する。 */
function extractDarkMediaContent(css: string): string {
  const results: string[] = [];
  const mediaStart =
    /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/g;
  for (const match of css.matchAll(mediaStart)) {
    const startBrace = match.index! + match[0].length - 1;
    let depth = 1;
    let i = startBrace + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    results.push(css.slice(startBrace + 1, i - 1));
  }
  return results.join('\n');
}

function extractCssVars(block: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const pattern = /(--[\w-]+)\s*:\s*([^;]+);/g;
  for (const match of block.matchAll(pattern)) {
    vars[match[1]] = match[2].trim();
  }
  return vars;
}

function extractRootBlock(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}\\s*\\{`);
  const match = pattern.exec(css);
  if (!match) return null;
  const startBrace = match.index! + match[0].length - 1;
  let depth = 1;
  let i = startBrace + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(startBrace + 1, i - 1);
}

function lightCssWithoutDarkMedia(css: string): string {
  const darkPattern =
    /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/g;
  let result = '';
  let lastIndex = 0;
  for (const match of css.matchAll(darkPattern)) {
    result += css.slice(lastIndex, match.index!);
    const startBrace = match.index! + match[0].length - 1;
    let depth = 1;
    let i = startBrace + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    lastIndex = i;
  }
  result += css.slice(lastIndex);
  return result;
}

function extractKindRuleProperties(
  css: string,
  kind: string,
): Partial<{ background: string; color: string }> {
  const selectorSuffix = `.hygiene-kind-${kind}`;
  const rulePattern = /([^{]+)\{([^}]*)\}/g;
  const props: Partial<{ background: string; color: string }> = {};
  for (const match of css.matchAll(rulePattern)) {
    const selectorList = match[1].split(',');
    const hits = selectorList.some((raw) => {
      const trimmed = raw.trim();
      return (
        trimmed.endsWith(selectorSuffix) ||
        trimmed.includes(`${selectorSuffix} `)
      );
    });
    if (!hits) continue;
    const body = match[2];
    const bg = body.match(/background\s*:\s*([^;]+)/);
    const fg = body.match(/(?:^|[\s;])color\s*:\s*([^;]+)/);
    if (bg) props.background = bg[1].trim();
    if (fg) props.color = fg[1].trim();
  }
  return props;
}

function resolveToken(
  value: string,
  tokens: Record<string, string>,
): string {
  const varMatch = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (varMatch) {
    const resolved = tokens[varMatch[1]];
    if (resolved === undefined) {
      throw new Error(`undefined token ${varMatch[1]}`);
    }
    return resolved;
  }
  return value;
}

function badgeContrast(
  background: string,
  foreground: string,
  elevatedBg: string,
  tokens: Record<string, string>,
): number {
  const bgRaw = resolveToken(background, tokens);
  const fgRaw = resolveToken(foreground, tokens);
  const elevated = parseCssColor(resolveToken(elevatedBg, tokens));
  const effectiveBg = compositeOver(parseCssColor(bgRaw), elevated);
  const fg = parseCssColor(fgRaw);
  return contrastRatio(fg, effectiveBg);
}

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

function getKindBadgeColors(
  kind: string,
  mode: 'light' | 'dark',
  lightCss: string,
  darkCss: string,
): { background: string; color: string } {
  if (INTENTIONALLY_DEFAULT_KINDS.has(kind)) {
    return {
      background: 'var(--badge-stalled-bg)',
      color: 'var(--badge-stalled-fg)',
    };
  }
  const sourceCss = mode === 'light' ? lightCss : darkCss;
  const props = extractKindRuleProperties(sourceCss, kind);
  const lightFallback = extractKindRuleProperties(lightCss, kind);
  const background = props.background ?? lightFallback.background;
  const color = props.color ?? lightFallback.color;
  if (!background || !color) {
    throw new Error(`missing colors for kind=${kind} mode=${mode}`);
  }
  return { background, color };
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

  // bdboard-i874: kind 追加時にダーク上書きを忘れると読めないバッジが増える。
  // CSS から色を抜いて WCAG 2.1 相対輝度式で 4.5:1 を機械検証する。
  it('meets WCAG AA (4.5:1) for every kind badge in light and dark', () => {
    const lightCss = lightCssWithoutDarkMedia(cssSource);
    const darkCss = extractDarkMediaContent(cssSource);
    expect(darkCss.trim().length).toBeGreaterThan(0);

    const firstMedia = cssSource.indexOf('@media');
    const lightRootBlock = extractRootBlock(
      cssSource.slice(0, firstMedia >= 0 ? firstMedia : cssSource.length),
      ':root',
    );
    expect(lightRootBlock).not.toBeNull();
    const lightTokens = extractCssVars(lightRootBlock!);

    const darkRootBlock = extractDarkMediaContent(cssSource);
    const darkRootInner = extractRootBlock(
      darkRootBlock,
      ":root:not([data-theme='light'])",
    );
    const darkTokens = {
      ...lightTokens,
      ...(darkRootInner ? extractCssVars(darkRootInner) : {}),
    };

    for (const key of [
      '--badge-stalled-bg',
      '--badge-stalled-fg',
      '--color-bg-elevated',
    ]) {
      expect(darkTokens[key], `token ${key}`).toBeDefined();
      expect(lightTokens[key], `token ${key}`).toBeDefined();
    }

    const failures: string[] = [];
    let checked = 0;
    for (const kind of [...expectedKinds].sort()) {
      for (const mode of ['light', 'dark'] as const) {
        checked++;
        const tokens = mode === 'light' ? lightTokens : darkTokens;
        const { background, color } = getKindBadgeColors(
          kind,
          mode,
          lightCss,
          darkCss,
        );
        const ratio = badgeContrast(
          background,
          color,
          tokens['--color-bg-elevated'],
          tokens,
        );
        if (ratio < MIN_CONTRAST) {
          failures.push(
            `${kind} (${mode}): ${ratio.toFixed(2)}:1 < ${MIN_CONTRAST}:1`,
          );
        }
      }
    }

    expect(checked).toBe(expectedKinds.size * 2);
    expect(failures).toEqual([]);
  });

  it('meets WCAG AA (4.5:1) for the default .hygiene-kind-badge in light and dark', () => {
    const firstMedia = cssSource.indexOf('@media');
    const lightRootBlock = extractRootBlock(
      cssSource.slice(0, firstMedia >= 0 ? firstMedia : cssSource.length),
      ':root',
    );
    const lightTokens = extractCssVars(lightRootBlock!);

    const darkRootBlock = extractDarkMediaContent(cssSource);
    const darkRootInner = extractRootBlock(
      darkRootBlock,
      ":root:not([data-theme='light'])",
    );
    const darkTokens = {
      ...lightTokens,
      ...(darkRootInner ? extractCssVars(darkRootInner) : {}),
    };

    const failures: string[] = [];
    for (const mode of ['light', 'dark'] as const) {
      const tokens = mode === 'light' ? lightTokens : darkTokens;
      const ratio = badgeContrast(
        'var(--badge-stalled-bg)',
        'var(--badge-stalled-fg)',
        tokens['--color-bg-elevated'],
        tokens,
      );
      if (ratio < MIN_CONTRAST) {
        failures.push(
          `default badge (${mode}): ${ratio.toFixed(2)}:1 < ${MIN_CONTRAST}:1`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  // このアプリのダークテーマは @media (prefers-color-scheme: dark) 内の
  // :root:not([data-theme='light']) だけが DOM に効く。[data-theme="dark"] など別形を
  // 足しても data-theme を設定するコードが無いので永久に適用されない。コントラスト比
  // 計算だけでは extractKindRuleProperties の endsWith 一致で誤って緑になる（bdboard-i874 実測）。
  it("only uses the app's single dark-theme selector form for kind badge overrides", () => {
    const darkCss = extractDarkMediaContent(cssSource);
    const rulePattern = /([^{]+)\{([^}]*)\}/g;
    const inspected: string[] = [];
    const offenders: string[] = [];
    const requiredPrefix = ":root:not([data-theme='light'])";

    for (const match of darkCss.matchAll(rulePattern)) {
      for (const raw of match[1].split(',')) {
        const trimmed = raw.trim();
        if (!trimmed.includes('.hygiene-kind-')) continue;
        inspected.push(trimmed);
        if (!trimmed.startsWith(requiredPrefix)) {
          offenders.push(trimmed);
        }
      }
    }

    expect(inspected.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
