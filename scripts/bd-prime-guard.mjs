// bdboard-njaf: `bd prime --hook-json` が Persistent Memories ブロックを丸ごと落とした
// 出力を返すことがある。SessionStart フックはこの出力だけがプロジェクトメモリの供給経路
// なので、落ちるとそのセッションはメモリ0件のまま始まる。
//
// 実測 (2026-09-04, bd 1.2.1 / Homebrew / embedded Dolt):
//   - `bd prime --hook-json` 40回中3回 (7.5%) で欠落。正常 22915 バイト / 欠落時 6372 バイト。
//   - exit code は 0、stderr は 0 バイト。完全に無音。
//   - ブロックは「空で出る」のではなく「見出しごと出ない」ので、件数 (0) すら表示されない。
//     出力は最後まで整形された正常な prime 出力に見え、読み手が気づく手がかりが無い。
//   - 当初 bd 側チケットは「remember/forget の連続実行直後だけ」と見ていたが、こちらから
//     memories へ一切書き込まずに再現した。通常運用中に起きる。
//
// bd 本体は外部ツール (Homebrew) なのでここでは直せない。このガードがやるのは2つだけ:
//   1. 欠落を検出したら1回だけ再実行する。7.5% が独立に起きるなら約 0.6% まで落ちる。
//   2. 再実行しても欠落したままなら、出力を握り潰さずに警告を差し込んで**可視化**する。
// 2 のほうが本質である。無音の失敗を音の出る失敗に変えるのが目的で、再試行はおまけ。
//
// 設計上の約束: bd の実行に失敗した / JSON として読めない場合は、出力を一切加工せず
// そのまま通す。ガードが原因で状況を悪化させないため。

export const MEMORIES_MARKER = '## Persistent Memories';

/**
 * `bd prime --hook-json` の生 stdout を分類する。
 *
 * - `ok`: memories ブロックがある。そのまま流してよい。
 * - `missing-memories`: JSON としては読めるが memories ブロックが無い。再実行/警告の対象。
 * - `unparsable`: JSON として読めない (bd の失敗、空出力、形式変更)。加工せず素通しする。
 */
export function classifyPrimeOutput(stdout) {
  if (typeof stdout !== 'string' || stdout.trim() === '') {
    return { status: 'unparsable' };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { status: 'unparsable' };
  }

  const context = parsed?.hookSpecificOutput?.additionalContext;
  if (typeof context !== 'string') {
    return { status: 'unparsable' };
  }

  return {
    status: context.includes(MEMORIES_MARKER) ? 'ok' : 'missing-memories',
    parsed,
  };
}

/** 欠落したまま確定したときに差し込む警告。読み手が自力で復旧できる指示を含める。 */
export const MISSING_MEMORIES_WARNING = [
  '⚠️ bd prime がプロジェクトメモリ (Persistent Memories) を返しませんでした (bdboard-njaf)。',
  'これは既知の断続的な不具合で、bd は exit 0 / stderr 無しで黙って落とすため、再実行するまで',
  '検出できません。このガードは既に1回再試行しており、それでも取得できていません。',
  'このセッションはプロジェクト固有の規律を知らない状態で始まっています。作業を進める前に',
  'bd prime を手動で実行し、Persistent Memories ブロックが出ることを確認してください。',
].join('\n');

/**
 * 欠落が確定した payload に警告を**先頭**へ差し込む。既存の context は捨てない。
 * 先頭に置くのは、長い出力の末尾だと読み飛ばされるため。
 */
export function annotateMissingMemories(parsed) {
  const context = parsed?.hookSpecificOutput?.additionalContext ?? '';
  return {
    ...parsed,
    hookSpecificOutput: {
      ...parsed.hookSpecificOutput,
      additionalContext: `${MISSING_MEMORIES_WARNING}\n\n${context}`,
    },
  };
}

/**
 * 2回分の試行結果から、最終的に出力すべき文字列を決める。純粋関数なのでテストできる。
 *
 * `runPrime` は stdout 文字列を返す関数。最大2回呼ばれる。
 */
export function resolvePrimeOutput(runPrime) {
  const first = runPrime();
  const firstResult = classifyPrimeOutput(first);
  if (firstResult.status !== 'missing-memories') {
    // ok も unparsable も、ここでは同じ扱い = 素通し。
    return { output: first, attempts: 1, status: firstResult.status };
  }

  const second = runPrime();
  const secondResult = classifyPrimeOutput(second);
  if (secondResult.status === 'ok') {
    return { output: second, attempts: 2, status: 'recovered' };
  }
  if (secondResult.status === 'unparsable') {
    // 2回目が壊れているなら、読めていた1回目に警告を足したほうが情報量が多い。
    return {
      output: JSON.stringify(annotateMissingMemories(firstResult.parsed)),
      attempts: 2,
      status: 'missing-memories',
    };
  }

  return {
    output: JSON.stringify(annotateMissingMemories(secondResult.parsed)),
    attempts: 2,
    status: 'missing-memories',
  };
}

// --- エントリポイント ---
// 直接実行されたときだけ bd を spawn する。上の純粋関数群はテストから import される。
// パス比較は pathToFileURL 経由で行う。`file://` + argv[1] の素の連結だと、空白や
// 非 ASCII を含むパスでエンコードが食い違って一致せず、フックが無言で何も出力しなくなる。
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const { spawnSync } = await import('node:child_process');

  const runPrime = () => {
    const result = spawnSync('bd', ['prime', '--hook-json'], {
      encoding: 'utf8',
      // stderr はそのまま親へ流す。bd が何か言っているなら握り潰さない。
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return result.stdout ?? '';
  };

  // このスクリプトは全セッションの SessionStart に挟まる。ここで例外を投げると
  // prime のコンテキストが丸ごと失われ、直そうとした症状より悪い状態になる。
  // どんな失敗でも「素の bd prime を1回流す」ところまでは必ず戻す。
  try {
    const { output, status, attempts } = resolvePrimeOutput(runPrime);
    if (status === 'recovered') {
      // 復旧した事実は stderr に残す。頻度が変わったときに気づけるようにするため
      // (stdout はフック契約の JSON 専用なので混ぜない)。
      process.stderr.write('bd-prime-guard: memories missing on attempt 1, recovered on retry\n');
    } else if (status === 'missing-memories') {
      process.stderr.write(`bd-prime-guard: memories still missing after ${attempts} attempts\n`);
    }
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`bd-prime-guard: falling back to plain bd prime (${error?.message ?? error})\n`);
    process.stdout.write(runPrime());
  }
}
