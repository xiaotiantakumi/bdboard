// bdboard-b0yd R2-1: `gh` の代役。scripts/check-drift.test.mjs だけが使う。
//
// 以前は「PATH の先頭に偽の `gh` シェルスクリプトを置く」方式だったが、
// `PATH: `${bin}:${process.env.PATH}`` が区切り文字を `:` で決め打ちしており
// Windows (`;`) では独立した PATH エントリにならず、fake-bin が無視されて
// **runner の本物の gh.exe が実行される**バグがあった (CI job 101323658456)。
// 区切り文字を直しても、拡張子なしの `#!/bin/sh` スクリプトは Windows の
// PATHEXT 解決に載らないため解決しない。
//
// このファイルは PATH にもシェバンにも依存しない: check-drift.mjs 側は
// `BDBOARD_DRIFT_GH` (= `process.execPath`) を execFileSync の実行ファイルに、
// `BDBOARD_DRIFT_GH_ARGS` (= `["<このファイルの絶対パス>"]`) をその前に置く
// 追加引数に使う。つまり実行されるのは常に `node fake-gh.mjs pr list ...` で、
// これは全プラットフォームで同じ経路を通る (Node が自分の argv を解釈するだけ)。
import fs from 'node:fs';

const argsFile = process.env.BDBOARD_DRIFT_FAKE_GH_ARGS_FILE;
if (argsFile) {
  const args = process.argv.slice(2);
  fs.writeFileSync(argsFile, args.length > 0 ? `${args.join('\n')}\n` : '');
}

// bdboard-b0yd R4-F2: process.exit() を stdout.write() の直後に呼ぶと、
// Windows ではパイプへの stdout 書き込みが非同期なため、書き込みが完了する
// 前にプロセスが終了して出力が切れうる。process.exitCode を設定して自然
// 終了させれば、Node が stdio のフラッシュを待ってから終了する。現状 CI は
// green だが (潜在的)、この PR は Windows 限定の壊れ方を既に1度出している。
process.stdout.write(process.env.BDBOARD_DRIFT_FAKE_GH_STDOUT ?? '');
process.stderr.write(process.env.BDBOARD_DRIFT_FAKE_GH_STDERR ?? '');
process.exitCode = Number.parseInt(process.env.BDBOARD_DRIFT_FAKE_GH_EXIT_CODE ?? '0', 10);
