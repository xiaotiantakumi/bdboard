// bdboard-eu2k: `npm run verify` の Node 版ガード。
//
// 背景: エージェントの非対話シェルは .nvmrc を読まないため、既定 node が古い版
// (実測 v14.15.0) のまま verify が走り、子の tsc/vite/vitest が `||=` の SyntaxError で
// 即死した。原因 (Node の版) が読み取れないエラーで落ちるので、verify.mjs の外側モードが
// 子プロセスを 1 つも起こす前に package.json の engines.node と照合し、満たさなければ
// 要求版・現在版・.nvmrc の案内を出して終わる。
//
// 制約: このファイルは古い Node でもパース・実行できなければ意味がない (ガードに
// 辿り着く前に SyntaxError で落ちる)。目安の下限は v14.13.1 — verify.mjs の静的 import が
// `node:` 指定子を、本体がトップレベル await を使うので、それより古い Node はガードに
// 届く前に落ちる。v14 でパースできない構文 (`||=` / `??=` /
// import attributes / クラスの private メソッドや static ブロック等) と、v14 に無い
// API (`Array.prototype.at` / `Object.hasOwn` / `structuredClone` 等) を使わない。
// package.json を `import ... with { type: 'json' }` で読まないのも同じ理由。
import fs from 'node:fs';
import path from 'node:path';

// "v14.15.0" / "22.9.0" / "22.9" / "22" / "22.9.0-pre" を受ける。prerelease/build
// 部分は比較に使わない (22.9.0-pre は 22.9.0 として扱う — 開発者向けガードとして十分)。
const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/;
// engines の書式のうち、この repo が使う ">=X.Y.Z" 形だけを解釈する。
const MINIMUM_RANGE_RE = /^>=\s*(v?\d+(?:\.\d+){0,2})\s*$/;

export function parseNodeVersion(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = VERSION_RE.exec(value.trim());
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
  };
}

// ">=22.9.0" → { major: 22, minor: 9, patch: 0 }。">=" 以外 (^, ~, ||, 範囲) は
// 解釈できないとして null を返す — 呼び出し側は fail-open (ガードで verify を壊さない)。
export function parseMinimumRange(range) {
  if (typeof range !== 'string') {
    return null;
  }
  const match = MINIMUM_RANGE_RE.exec(range.trim());
  if (match === null) {
    return null;
  }
  return parseNodeVersion(match[1]);
}

function compareVersions(a, b) {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

// current が range (">=X.Y.Z") を満たすか。range や current が解釈できないときは
// true (fail-open): engines の書式を将来変えたときにガードが verify 全体を止める方が害が大きい。
export function satisfiesMinimum(current, range) {
  const minimum = parseMinimumRange(range);
  if (minimum === null) {
    return true;
  }
  const version = parseNodeVersion(current);
  if (version === null) {
    return true;
  }
  return compareVersions(version, minimum) >= 0;
}

// package.json の engines.node。読めない・無い・文字列でないときは undefined。
export function readEnginesNodeRange(repoRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const range = pkg && pkg.engines && pkg.engines.node;
    return typeof range === 'string' ? range : undefined;
  } catch {
    return undefined;
  }
}

function readNvmrc(repoRoot) {
  try {
    const value = fs.readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8').trim();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

export function formatNodeVersionError({ current, required, nvmrc }) {
  const currentLabel = `v${String(current).replace(/^v/, '')}`;
  const lines = [
    `verify: Node.js ${required} が必要ですが、実行中の Node.js は ${currentLabel} です (package.json の engines.node)。`,
    'verify: tsc / vite / vitest を 1 つも起動せずに終了します。',
  ];
  if (nvmrc !== undefined) {
    lines.push(
      `verify: .nvmrc (= ${nvmrc}) は自動では適用されません (非対話シェルは nvm を読み込まないことがある)。Node ${nvmrc} 系のうち ${required} を満たす版を明示してから再実行してください:`,
      `verify:   PATH の先頭にその版の bin を置く (例: export PATH="$HOME/.nvm/versions/node/<${nvmrc} 系で ${required} を満たす版>/bin:$PATH")`,
      'verify:   または nvm を読み込んでから切り替える: . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use',
    );
  } else {
    lines.push(`verify: PATH の先頭に Node.js ${required} を満たす node の bin を置いてから再実行してください。`);
  }
  return lines.join('\n');
}

export function checkNodeVersion({ repoRoot, nodeVersion = process.versions.node }) {
  const required = readEnginesNodeRange(repoRoot);
  if (satisfiesMinimum(nodeVersion, required)) {
    return { ok: true };
  }
  return {
    ok: false,
    message: formatNodeVersionError({ current: nodeVersion, required, nvmrc: readNvmrc(repoRoot) }),
  };
}
