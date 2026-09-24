#!/usr/bin/env node
// bdboard-ynp1: `npm run verify` から呼ぶ ESLint の要約ラッパー。
//
// 背景: `npm run lint` は既存の warning が約2400件 (台帳は eslint.config.mjs のコメント)
// あり、verify のたびに全件出力するとエージェントや CI のログで本当の失敗 (error) が
// 埋もれる。error の検出自体は弱めない — ESLint の実行内容・ルール・exit code の意味は
// `npm run lint` と同じで、error が1件でもあれば exit 1 のまま。
//
// 挙動:
// - error が無ければ、warning は1件も出力せず件数だけ1行で出して exit 0。
// - error が1件でもあれば、その error だけを (--quiet と同じ絞り込みで) stylish
//   フォーマッタで出力し exit 1。warning に埋もれて error を見落とすことがない。
// - warning の全文が見たいときは `npm run lint:warnings` (旧来の `npm run lint` と
//   同じ、絞り込み無しの通常実行) を使う。
import { ESLint } from 'eslint';

const LINT_TARGETS = ['src', 'web/src', 'scripts'];
const CACHE_LOCATION = '.eslintcache';

async function main() {
  const eslint = new ESLint({
    cache: true,
    cacheLocation: CACHE_LOCATION,
  });
  const results = await eslint.lintFiles(LINT_TARGETS);

  let errorCount = 0;
  let warningCount = 0;
  for (const result of results) {
    errorCount += result.errorCount;
    warningCount += result.warningCount;
  }

  if (errorCount > 0) {
    // ESLint 標準の --quiet と同じ絞り込み: severity 2 (error) のメッセージだけ残す。
    const errorResults = results.map((result) => ({
      ...result,
      messages: result.messages.filter((message) => message.severity === 2),
      warningCount: 0,
      fixableWarningCount: 0,
    }));
    const formatter = await eslint.loadFormatter('stylish');
    const output = await formatter.format(errorResults);
    if (output) {
      process.stdout.write(`${output}\n`);
    }
    console.error(
      `eslint: ${errorCount} error(s), ${warningCount} warning(s) (warning の全文は npm run lint:warnings)`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`eslint: 0 errors, ${warningCount} warnings (詳細は npm run lint:warnings)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
