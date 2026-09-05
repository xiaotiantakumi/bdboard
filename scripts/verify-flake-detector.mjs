// bdboard-8rl8: `npm run verify` が非ゼロで落ちたとき、それが
//   (a) bdboard-c6nv で追跡している vitest upstream の既知 flake
//       ([vitest-worker]: Timeout calling "onTaskUpdate" が unhandled error として
//       計上されるだけで、実テストは全件成功している)
//   (b) 実際にテストが failed した本物の失敗
// のどちらであるかを、verify がキャプチャした標準出力/標準エラー出力のテキストから
// 判定する。
//
// 判定の向き (これがこのチケットの本体、取り違え厳禁):
//   - 実失敗 (failed テスト) が 0 件 かつ onTaskUpdate タイムアウトの痕跡がある
//     → 'known-flake' (既知 flake として明示してよい)
//   - 実失敗が 1 件以上 → onTaskUpdate が同居していても 'real-failure'
//     (2026-09-06 の bdboard-6y5b で実際に併発した組み合わせ。これを 'known-flake' に
//     倒すと実バグを握り潰す最悪の挙動になる)
//   - vitest の "Tests" サマリ行が 1 つも見つからない (出力の書式が変わった、
//     vitest 自体が走っていない等) → 'undetermined'。安全側に倒して
//     'known-flake' は絶対に返さない — 判定不能を黙って既知 flake 扱いしない。
//
// vitest v3 の実際の出力例 (bdboard-c6nv / bdboard-8rl8 チケット本文より):
//   成功時: ` Tests  3394 passed | 1 skipped (3395)`
//   失敗時: ` Tests  1 failed | 3300 passed | 85 skipped (3384)`
// "Test Files" 行 (`Test Files  237 passed | 2 skipped (239)`) は対象外 —
// "Tests" とは別の行で、こちらはファイル単位の集計なので使わない。
//
// このモジュールは vitest プロセスを一切起動しない純粋関数のみを export する
// (verify-flake-detector.test.mjs で文字列を直接渡してテストできるようにするため)。
// 実際のキャプチャ・呼び出しは verify.mjs 側で行う。

export const ON_TASK_UPDATE_TIMEOUT_SIGNATURE = 'Timeout calling "onTaskUpdate"';

// "Tests" サマリ行そのもの (行頭の空白を許容し、"Test Files" は "Tests" にマッチしない —
// 直後に来るのは空白であって "Files" ではないため)。
const TESTS_SUMMARY_LINE_RE = /^[ \t]*Tests[ \t]+.+$/gm;
// サマリ行の中から failed 件数を取り出す。無ければそのサマリ行の failed は 0 件。
const TESTS_FAILED_COUNT_RE = /^[ \t]*Tests[ \t]+(\d+)[ \t]+failed\b/;

/**
 * @param {string} output verify がキャプチャした結合済み stdout+stderr テキスト
 * @returns {{
 *   status: 'known-flake' | 'real-failure' | 'other' | 'undetermined',
 *   failedCount: number | null,
 *   hasOnTaskUpdateTimeout: boolean,
 *   summaryLineCount: number,
 * }}
 */
export function classifyVerifyOutput(output) {
  const text = typeof output === 'string' ? output : '';
  const hasOnTaskUpdateTimeout = text.includes(ON_TASK_UPDATE_TIMEOUT_SIGNATURE);
  const summaryLines = text.match(TESTS_SUMMARY_LINE_RE) ?? [];

  if (summaryLines.length === 0) {
    // vitest の "Tests" サマリが 1 行も見つからない = 実失敗 0 件を裏付けられない。
    // 書式変更・vitest 未実行などいずれの理由でも、既知 flake とは判定しない
    // (安全側に倒す — bdboard-8rl8 のやること参照)。
    return { status: 'undetermined', failedCount: null, hasOnTaskUpdateTimeout, summaryLineCount: 0 };
  }

  let failedCount = 0;
  for (const line of summaryLines) {
    const match = TESTS_FAILED_COUNT_RE.exec(line);
    if (match) {
      failedCount += Number(match[1]);
    }
  }

  if (failedCount > 0) {
    // 実失敗が優先される。onTaskUpdate が同居していても既知 flake とは言わない。
    return { status: 'real-failure', failedCount, hasOnTaskUpdateTimeout, summaryLineCount: summaryLines.length };
  }

  if (hasOnTaskUpdateTimeout) {
    return { status: 'known-flake', failedCount, hasOnTaskUpdateTimeout, summaryLineCount: summaryLines.length };
  }

  return { status: 'other', failedCount, hasOnTaskUpdateTimeout, summaryLineCount: summaryLines.length };
}

/**
 * classifyVerifyOutput() が 'known-flake' を返したときに表示する説明文を組み立てる。
 * @param {ReturnType<typeof classifyVerifyOutput>} classification
 * @returns {string}
 */
export function formatKnownFlakeNotice(classification) {
  const lines = [
    '='.repeat(70),
    'verify: known flake detected (bdboard-c6nv)',
    '',
    `  [vitest-worker]: ${ON_TASK_UPDATE_TIMEOUT_SIGNATURE} が unhandled error として`,
    '  計上されていますが、テスト自体は全件成功しています',
    `  ("Tests" サマリ行 ${classification.summaryLineCount} 件中、failed は 0 件)。`,
    '',
    '  これは vitest 本体の未解決 upstream バグ (birpc の RPC ACK タイムアウトが',
    '  60秒でハードコードされておりプール側から上書きできない) による既知の',
    '  偽陽性失敗です。あなたの変更が原因ではありません。詳細は bdboard-c6nv。',
    '  再実行で解消する見込みですが、このツールは自動 rerun を行いません',
    '  (verify の終了コードは変更せず非ゼロのまま返します — 対応要)。',
    '='.repeat(70),
  ];
  return lines.join('\n');
}
