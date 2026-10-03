// bdboard-4dqo: scripts/merge-pr.test-support.mjs が一時リポジトリへ書き込む偽の検証コマンド (`node verify.cjs`)。
// harness を max-lines (非テスト 200 行) に収めるために別モジュールへ出しただけで、中身は
// scripts/merge-pr.test.mjs の VERIFY_JS だったものそのまま。どの SHA を検証したかをログに残し、
// FAKE_VERIFY_* 環境変数で終了コード・待ち時間・中断・意味的衝突などを演出する。
export const VERIFY_JS = `
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const head = execSync('git rev-parse HEAD').toString().trim();
fs.appendFileSync(process.env.FAKE_VERIFY_LOG, head + '\\n');
// SIGINT/SIGTERM のテスト用: 自分の (実際に検証を実行している) pid を書いておく。中断後に
// この pid が本当に死んでいるかで「子プロセスが孤児にならない」ことを確かめる。
if (process.env.FAKE_VERIFY_PID_FILE) fs.writeFileSync(process.env.FAKE_VERIFY_PID_FILE, String(process.pid));
// bdboard-ulxa.6: merge-pr が verify スロットに渡す優先度と並んだ時刻を記録する。
if (process.env.FAKE_VERIFY_ENV_LOG) fs.appendFileSync(process.env.FAKE_VERIFY_ENV_LOG, (process.env.BDBOARD_VERIFY_PRIORITY || '-') + ' ' + (process.env.BDBOARD_VERIFY_QUEUE_SINCE || '-') + '\\n');
// bdboard-e8o1: 孫プロセスの kill 確認用。設定されていれば、この検証プロセス自身の子として
// (detached せずに) 別の node プロセスを spawn する。同じプロセスグループに入るので、グループ
// 宛ての SIGTERM/SIGKILL は届くが、この孫は SIGTERM を無視する (見送り分 1 のポーリング確認:
// 直接の子 (このプロセス自身) は SIGTERM で即座に死ぬので、孫が SIGTERM を無視しないと
// 「直接の子の 'close' を見て後始末完了とみなす」旧実装でもたまたま道連れで死んでしまい、
// 新しいポーリング (SIGTERM で死ななければ猶予後に SIGKILL を送り直す) を検証できない)。
const grandchildPidFile = process.env.FAKE_VERIFY_GRANDCHILD_PID_FILE;
if (grandchildPidFile) {
  const { spawn } = require('node:child_process');
  const grandchildScript = "process.on('SIGTERM', () => {}); const fs=require('node:fs'); fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);";
  const grandchild = spawn(process.execPath, ['-e', grandchildScript], {
    stdio: 'ignore',
    env: { ...process.env, GRANDCHILD_PID_FILE: grandchildPidFile },
  });
  grandchild.unref();
}
// 意味的衝突の代役: 列挙したファイルが全部そろった木でだけ落ちる (片方だけなら緑)。
const conflict = process.env.FAKE_VERIFY_CONFLICT;
if (conflict && conflict.split(',').every((file) => fs.existsSync(file))) process.exit(3);
// verify の最中に main が動いたことの代役。
if (process.env.FAKE_VERIFY_MOVE_MAIN) execSync('git push -q origin ' + process.env.FAKE_VERIFY_MOVE_MAIN + ':refs/heads/main');
const sleepMs = Number(process.env.FAKE_VERIFY_SLEEP_MS || 0);
if (sleepMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
process.exit(Number(process.env.FAKE_VERIFY_EXIT || 0));
`;
