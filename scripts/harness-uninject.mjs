#!/usr/bin/env node
// bdboard-l1m1.7: 注入したハーネスパックを注入先から外す (uninject)。実行はユーザーが自分の端末で行う。
//
// 使い方: node <bdboard のルート>/scripts/harness-uninject.mjs --project <パス> --pack <名前> [--yes]
//   - 既定は dry-run (何を消すかを表示するだけ)。
//   - --yes は、標準入力が TTY で、かつ環境変数 CLAUDECODE が無いときだけ通り、一覧の後に
//     /dev/tty でパック名を入力させる。エージェントの Bash は TTY も無く CLAUDECODE もあるので拒否される。
//     (擬似端末・環境変数の削除で抜けられるため、deny と hook の併用が前提。)
//     エージェントはこのコマンドを実行せず、ユーザーに提示するだけにする。
//   - 注入先への書き込みのみ。bdboard のサーバーは経由しない。commit もしない。
//
// 規則 (依存されているパックは外せない・自己注入先は拒否・hook の除去・.gitignore の戻し方) は
// src/ の TypeScript が正で、ここは tsx で読み込んで呼ぶだけの薄い殻 (規則を二か所に書かない)。
// tsx は bdboard の実行時依存 (bin/bdboard.mjs と同じ)。
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

register();

const { runHarnessUninject } = await import(
  new URL('../src/infrastructure/harness/harness-uninject-cli.ts', import.meta.url).href
);

const packsRoot = fileURLToPath(new URL('../harness/packs', import.meta.url));

/**
 * 制御端末 (/dev/tty) で 1 行の答えを取る。標準入力は使わない (パイプや擬似端末への流し込みで
 * 答えさせないため)。端末を開けなければ null。
 */
function askTty(question) {
  return new Promise((resolve) => {
    const input = fs.createReadStream('/dev/tty');
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      input.destroy();
      resolve(answer);
    };
    input.on('error', () => finish(null));
    input.on('open', () => {
      const output = fs.createWriteStream('/dev/tty');
      output.on('error', () => finish(null));
      const rl = readline.createInterface({ input, output });
      rl.question(question, (answer) => {
        rl.close();
        output.end();
        finish(answer.trim());
      });
    });
  });
}

try {
  process.exitCode = await runHarnessUninject(
    process.argv.slice(2),
    {
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
      stdinIsTty: process.stdin.isTTY === true,
      // 値は読まない。設定の有無だけ見る (Claude Code の中では設定されている)。
      insideAgent: Object.hasOwn(process.env, 'CLAUDECODE'),
      askTty,
    },
    packsRoot,
  );
} catch (error) {
  process.stderr.write(`失敗: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write(
    '途中まで進んでいる場合があります。同じコマンドをもう一度実行すれば続きから終えられます。\n',
  );
  process.exitCode = 1;
}
