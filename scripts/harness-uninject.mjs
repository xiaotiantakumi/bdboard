#!/usr/bin/env node
// bdboard-l1m1.7: 注入したハーネスパックを注入先から外す (uninject)。実行はユーザーが自分の端末で行う。
//
// 使い方: node <bdboard のルート>/scripts/harness-uninject.mjs --project <パス> --pack <名前> [--yes]
//   - 既定は dry-run (何を消すかを表示するだけ)。
//   - --yes は対話端末 (標準入力が TTY) でしか実行できない。エージェントの Bash は TTY が無いので
//     機械的に拒否される。エージェントはこのコマンドを実行せず、ユーザーに提示するだけにする。
//   - 注入先への書き込みのみ。bdboard のサーバーは経由しない。commit もしない。
//
// 規則 (依存されているパックは外せない・自己注入先は拒否・hook の除去・.gitignore の戻し方) は
// src/ の TypeScript が正で、ここは tsx で読み込んで呼ぶだけの薄い殻 (規則を二か所に書かない)。
// tsx は bdboard の実行時依存 (bin/bdboard.mjs と同じ)。
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

register();

const { runHarnessUninject } = await import(
  new URL('../src/infrastructure/harness/harness-uninject-cli.ts', import.meta.url).href
);

const packsRoot = fileURLToPath(new URL('../harness/packs', import.meta.url));

try {
  process.exitCode = await runHarnessUninject(
    process.argv.slice(2),
    {
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
      stdinIsTty: process.stdin.isTTY === true,
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
