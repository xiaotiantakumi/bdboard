// bdboard-qoxg: scripts/always-on-server.sh の「停止前の node 版ゲート」。
//
// 背景: 2026-09-26 に議長シェルの既定 node が nvm の v14.15.0 のまま deploy が走り、
// build:web の vite build が `||=` の SyntaxError を UnhandledPromiseRejectionWarning として
// 出すだけで exit 0 になった。スクリプトは build 成功と判定して旧 listener を停止し、
// `npm run start` は tsx の構文エラーで即死、サーバーは約 10 分止まった。build の終了コードは
// 当てにならないので、旧 listener を止める前 (always-on-server.sh では pull の直後) に、
// main checkout の package.json の engines.node と PATH 上の node を突き合わせる。
//
// 使い方: node scripts/node-version-check.mjs <repoRoot>
//   exit 0 = 満たす (engines.node が読めない・">=X.Y.Z" 以外で解釈できないときも fail-open、出力なし)
//   exit 3 = 満たさない (stdout に要件・現在版・使うべき node の案内。PATH は書き換えない)
//   それ以外 = このチェッカー自体が実行できなかった (古すぎる node 等)。呼び出し側 (bash) が
//              exit 3 と区別して fail-closed にする。
//
// 制約: このファイルは古い Node でもパース・実行できなければ意味がない (ゲートに辿り着く前に
// SyntaxError で落ちる)。scripts/node-version-guard.mjs と同じく目安の下限は v14.13.1 —
// `||=` / `??=` / `?.` / `??` / import attributes / クラスの private メソッドや static ブロック、
// `Array.prototype.at` / `Object.hasOwn` / `structuredClone`、トップレベル await を使わない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseNodeVersion, readEnginesNodeRange, readNvmrc, satisfiesMinimum } from './node-version-guard.mjs';

export const EXIT_OK = 0;
export const EXIT_SHORTFALL = 3;

const LINE_PREFIX = 'always-on-server: ';

function compareVersions(a, b) {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

// <nvmDir>/versions/node/v*/bin/node のうち range を満たすものから、使うべき node の bin
// ディレクトリを 1 つ選ぶ。nvmrc の major と一致するものを優先し、無ければ major を問わず
// 最も高い版。見つからない・読めないときは null (throw しない)。
export function findNvmNodeBin({ range, nvmrc, nvmDir }) {
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  let names;
  try {
    names = fs.readdirSync(versionsDir);
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of names) {
    if (!/^v\d/.test(name)) {
      continue;
    }
    const version = parseNodeVersion(name);
    if (version === null || !satisfiesMinimum(name, range)) {
      continue;
    }
    const binDir = path.join(versionsDir, name, 'bin');
    if (!fs.existsSync(path.join(binDir, 'node'))) {
      continue;
    }
    candidates.push({ version, binDir });
  }
  if (candidates.length === 0) {
    return null;
  }
  const wanted = parseNodeVersion(nvmrc);
  let pool = candidates;
  if (wanted !== null) {
    const sameMajor = candidates.filter((candidate) => candidate.version.major === wanted.major);
    if (sameMajor.length > 0) {
      pool = sameMajor;
    }
  }
  pool.sort((a, b) => compareVersions(b.version, a.version));
  return pool[0].binDir;
}

export function formatShortfallLines({ current, nodePath, required, nvmrc, nvmBin }) {
  const currentLabel = `v${String(current).replace(/^v/, '')}`;
  const lines = [
    `Node.js ${required} が必要ですが、PATH 上の node は ${currentLabel} (${nodePath}) です (package.json の engines.node)。`,
  ];
  if (nvmBin !== null) {
    lines.push(
      `使うべき node: ${nvmBin} (nvm)`,
      `例: PATH="${nvmBin}:$PATH" BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh <action> ...`,
    );
  } else if (nvmrc !== undefined) {
    lines.push(
      `.nvmrc (= ${nvmrc}) は自動では適用されません。その系列で ${required} を満たす node の bin を PATH の先頭に置いて再実行してください。`,
    );
  } else {
    lines.push(`${required} を満たす node の bin を PATH の先頭に置いて再実行してください。`);
  }
  lines.push('node の切り替えは行いません (PATH は書き換えません)。');
  return lines.map((line) => `${LINE_PREFIX}${line}`);
}

export function main(argv, env) {
  const repoRoot = argv[0] === undefined ? process.cwd() : argv[0];
  const required = readEnginesNodeRange(repoRoot);
  const current = process.versions.node;
  if (satisfiesMinimum(current, required)) {
    return EXIT_OK;
  }
  const nvmrc = readNvmrc(repoRoot);
  const nvmDir = env.NVM_DIR ? env.NVM_DIR : path.join(os.homedir(), '.nvm');
  const lines = formatShortfallLines({
    current,
    nodePath: process.execPath,
    required,
    nvmrc,
    nvmBin: findNvmNodeBin({ range: required, nvmrc, nvmDir }),
  });
  process.stdout.write(`${lines.join('\n')}\n`);
  return EXIT_SHORTFALL;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
