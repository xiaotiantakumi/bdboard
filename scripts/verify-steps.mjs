// bdboard-ulxa.3: scripts/verify.mjs がどの npm script を走らせるかの振り分け (PR #854 レビューでテストのために
// 純関数として切り出した。verify.mjs は import するだけでスロットを取りにいくのでテストから読めない)。
//
// `npm run verify -- --light` は merge-pr (merge.mode S3) のクラス L 専用の軽量チェックで、verify:light
// (verify:steps から test:server / test:web を抜いたもの) を走らせる。それ以外は verify:steps。
// verify.mjs の import graph に入るので、古い Node でもパースできる構文に保つ (verify.mjs 冒頭の bdboard-eu2k)。
export const LIGHT_FLAG = '--light';

/** 走らせる npm script の名前。 */
export function stepsScriptFor(argv) {
  return argv.includes(LIGHT_FLAG) ? 'verify:light' : 'verify:steps';
}

/** 外側がリーダー (新プロセスグループ) を起こすときの引数。リーダーは自分の argv で振り分けるので --light を引き継ぐ。 */
export function leaderArgsFor(argv) {
  return argv.includes(LIGHT_FLAG) ? ['--group-leader', LIGHT_FLAG] : ['--group-leader'];
}
