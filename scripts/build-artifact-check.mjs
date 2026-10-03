// bdboard-5st4: scripts/always-on-server.sh の「停止前の build 成果物ゲート」。
//
// 背景: 2026-09-26 の事故 (bdboard-qoxg) では、古い node (v14.15.0) で走った build:web の
// `vite build` が `||=` の SyntaxError を UnhandledPromiseRejectionWarning として出すだけで
// exit 0 になり、web/dist/index.html は古いまま残った。build 末尾の write-build-meta は
// 走るので web/dist/build-meta.json だけが HEAD の sha になる。つまり「build の終了コード」も
// 「build-meta.json の sha が HEAD と一致」も、この事故では当てにならない。
// 見るべきは成果物そのもの: web/dist/index.html が、今回の build:web が始まった時刻より
// 後に作られたか。always-on-server.sh は build の直前に stamp ファイルを作り、build の後・
// 旧 listener を止める前にこのチェッカーを呼ぶ。
//
// 使い方: node scripts/build-artifact-check.mjs <artifact> <stamp>
//   exit 0 = artifact が stamp 以降に更新されている (出力なし)
//   exit 3 = artifact が無い・空・stamp より古い (stdout に理由。always-on-server.sh が exit 2 で止める)
//   それ以外 = このチェッカー自体が実行できなかった (stamp が読めない等)。呼び出し側が fail-closed にする。
//
// mtime は stat コマンドを介さず fs.statSync で読む (macOS の BSD stat は -f、Linux の GNU stat は
// -c で、-f は GNU では「ファイルシステム情報」になる。同じ書き方が通らない)。比較は秒単位に
// 切り捨てて行う: artifact と stamp が別のファイルシステム (秒精度のものとナノ秒精度のもの) に
// あっても、今回の build で作られた artifact を古いと誤判定しないため。同じ秒の内に前回の build が
// 終わっていた場合を見逃すが、build は数秒以上かかるので実害のない側に倒している。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXIT_OK = 0;
export const EXIT_STALE = 3;
export const EXIT_UNAVAILABLE = 1;

const LINE_PREFIX = 'always-on-server: ';

const toSeconds = (mtimeMs) => Math.floor(mtimeMs / 1000);

// artifact が stamp 以降に更新されたかを判定する。stamp が読めないときは throw する (呼び出し側が
// exit 1 = チェッカー失敗として扱う)。artifact が無い・普通のファイルでない・空のときは理由付きで ok: false。
export function checkArtifact({ artifact, stamp }) {
  const stampStat = fs.statSync(stamp);
  let artifactStat;
  try {
    artifactStat = fs.statSync(artifact);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: false, reason: 'missing', artifact };
    }
    throw error;
  }
  if (!artifactStat.isFile() || artifactStat.size === 0) {
    return { ok: false, reason: 'empty', artifact };
  }
  const artifactSec = toSeconds(artifactStat.mtimeMs);
  const stampSec = toSeconds(stampStat.mtimeMs);
  if (artifactSec < stampSec) {
    return {
      ok: false,
      reason: 'stale',
      artifact,
      artifactMtime: new Date(artifactStat.mtimeMs).toISOString(),
      stampMtime: new Date(stampStat.mtimeMs).toISOString(),
    };
  }
  return { ok: true };
}

export function formatStaleLines(result) {
  const name = path.basename(result.artifact);
  const lines = [];
  if (result.reason === 'missing') {
    lines.push(`${result.artifact} がありません。build:web は成功を返しましたが、${name} を作っていません。`);
  } else if (result.reason === 'empty') {
    lines.push(`${result.artifact} が空か、普通のファイルではありません。build:web は成功を返しましたが、${name} を作れていません。`);
  } else {
    lines.push(
      `${result.artifact} の更新時刻 (${result.artifactMtime}) が、今回の build:web の開始 (${result.stampMtime}) より前です。`,
      `build:web は成功を返しましたが、${name} を作り直していません (古い成果物がそのまま残っています)。`,
    );
  }
  lines.push(
    '原因の例: 古い node では vite が構文エラーを握りつぶして exit 0 を返す (2026-09-26, bdboard-qoxg)。node --version と、上の build の出力を確認してください。',
  );
  return lines.map((line) => `${LINE_PREFIX}${line}`);
}

export function main(argv, io = process) {
  if (argv.length !== 2) {
    io.stderr.write('usage: node scripts/build-artifact-check.mjs <artifact> <stamp>\n');
    return EXIT_UNAVAILABLE;
  }
  const result = checkArtifact({ artifact: argv[0], stamp: argv[1] });
  if (result.ok) {
    return EXIT_OK;
  }
  io.stdout.write(`${formatStaleLines(result).join('\n')}\n`);
  return EXIT_STALE;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`build-artifact-check: ${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = EXIT_UNAVAILABLE;
  }
}
