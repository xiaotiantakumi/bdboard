// bdboard-e8jj: scripts/merge-pr.load-retry.test.mjs が偽の検証コマンド (verify.cjs) の再実行のときだけ起こす子プロセス。
// 本物の `npm run verify` の再実行がスロットに対してすること (acquireVerifySlot が自分の holder を書き、merge-pr の予約を消す)
// を、予約の削除 (unlinkSync) が EPERM で失敗する環境 (Windows の一過性) で行う。予約が merge-pr の手で消えるまで
// RETRY_CHILD_WAIT_MS を上限に待ち、見えたこと (presentAtStart / goneWhileRunning / warnings) を RETRY_CHILD_REPORT に書く。
import * as fs from 'node:fs';

import { acquireVerifySlot, envSlotOptions } from './verify-slot.mjs';

const handoff = process.env.BDBOARD_VERIFY_SLOT_HANDOFF;
const warnings = [];
const io = {
  ...fs,
  unlinkSync() {
    const error = new Error('simulated Windows unlink failure');
    error.code = 'EPERM';
    throw error;
  },
};

const presentAtStart = fs.existsSync(handoff);
const slot = await acquireVerifySlot({ ...envSlotOptions(), io, settleMs: 0, pollMs: 20 }, (line) => warnings.push(line));
const deadline = Date.now() + Number(process.env.RETRY_CHILD_WAIT_MS);
while (fs.existsSync(handoff) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
fs.writeFileSync(process.env.RETRY_CHILD_REPORT, JSON.stringify({ warnings, presentAtStart, goneWhileRunning: !fs.existsSync(handoff) }));
slot.release();
