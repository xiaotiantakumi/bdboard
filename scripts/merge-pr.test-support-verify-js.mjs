// bdboard-4dqo: scripts/merge-pr.test-support.mjs が一時リポジトリへ書き込む偽の検証コマンド (`node verify.cjs`)。
// harness を max-lines (非テスト 200 行) に収めるために別モジュールへ出しただけで、中身は
// scripts/merge-pr.test.mjs の VERIFY_JS だったものそのまま。どの SHA を検証したかをログに残し、
// FAKE_VERIFY_* 環境変数で終了コード・待ち時間・中断・意味的衝突などを演出する。
export const VERIFY_JS = `
const fs = require('node:fs');
const { execFileSync, execSync } = require('node:child_process');
const head = execSync('git rev-parse HEAD').toString().trim();
// bdboard-ulxa.3: 軽量チェック (merge.lightCheck = 'node verify.cjs --light') は行末に --light を付けて区別する。
fs.appendFileSync(process.env.FAKE_VERIFY_LOG, head + (process.argv.includes('--light') ? ' --light' : '') + '\\n');
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
// verify の最中に main が動いたことの代役。remote 名ではなく URL へ push する: 名前宛ての push は
// remote を動かした後で refs/remotes/origin/main を lock して更新する。main が動いたのを見た abandon の
// SIGTERM が、git が lock ファイルを作ってから後始末の対象に登録するまでの隙間に当たると lock が残り、
// 以後の fetch が全部落ちる (bdboard-rlvz。負荷で隙間が広がる。SIGKILL は要らない — このテストの猶予は既定の 8 秒)。
if (process.env.FAKE_VERIFY_MOVE_MAIN) {
  const originUrl = execFileSync('git', ['remote', 'get-url', 'origin']).toString().trim();
  execFileSync('git', ['push', '-q', originUrl, process.env.FAKE_VERIFY_MOVE_MAIN + ':refs/heads/main']);
}
const sleepMs = Number(process.env.FAKE_VERIFY_SLEEP_MS || 0);
if (sleepMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
// bdboard-xdk8: 負荷由来の失敗の再実行のテスト用。FAKE_VERIFY_OUTPUT_FILE の中身を verify のログとして出し、
// FAKE_VERIFY_EXIT_SEQUENCE (例 "1,0") の n 回目の値で終わる (回数は FAKE_VERIFY_SEQUENCE_FILE に数える)。
if (process.env.FAKE_VERIFY_OUTPUT_FILE) process.stdout.write(fs.readFileSync(process.env.FAKE_VERIFY_OUTPUT_FILE, 'utf8'));
let exitCode = Number(process.env.FAKE_VERIFY_EXIT || 0);
if (process.env.FAKE_VERIFY_EXIT_SEQUENCE) {
  const seqFile = process.env.FAKE_VERIFY_SEQUENCE_FILE;
  const count = fs.existsSync(seqFile) ? Number(fs.readFileSync(seqFile, 'utf8')) : 0;
  fs.writeFileSync(seqFile, String(count + 1));
  const exits = process.env.FAKE_VERIFY_EXIT_SEQUENCE.split(',');
  exitCode = Number(exits[Math.min(count, exits.length - 1)]);
}
process.exit(exitCode);
`;
