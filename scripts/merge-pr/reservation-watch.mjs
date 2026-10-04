// bdboard-e8jj: merge-pr が着地後検証の再実行のために置いた予約 holder (scripts/verify-slot.mjs の reserveVerifySlot) を、
// 再実行の verify の holder が見えた時点で merge-pr 自身が消すための監視。
//
// 再実行の verify.mjs は自分の holder を書いた後で予約を消すが、その削除が ENOENT 以外 (Windows の EPERM 等) で失敗すると
// 警告だけで続ける。予約は「走らない landed の待ち手」なので、残っている間ほかの待ち手の計画から 2 枠目を奪う
// (幽霊枠)。merge-pr の finally は再実行が戻るまで消せないので、再実行が見えた時点で消す。通常は幽霊枠が poll 1 回分で
// 済むが、merge-pr 自身の unlink も同じ一過性で失敗しうるので、ファイルが無くなるまで毎周消し直す。それでも消せない間は
// 再実行が戻るまで残る (finally が最後の砦)。
// 再実行の holder は予約と同じ since (BDBOARD_VERIFY_QUEUE_SINCE として渡した値) の retry: true の landed holder で見分ける
// (pid や起動時刻での素性の確認はしない)。予約を消すのは再実行が自分の席を持った後なので、席の隙間は生まれない。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { HOLDER_NAME } from '../verify-slot-files.mjs';
import { HOLDER_FORMAT } from '../verify-slot-queue.mjs';

// holder の中身は readOthers (verify-slot-files.mjs) では読まない: あれは古い・壊れた他人の holder を消す副作用を持つので、
// 見るだけの監視には使えない。

/** dir に、予約 reservationPath の再実行 (retry: true の landed holder で since が同じもの) の holder があるか。読めないものは無視する。 */
export function retryHolderAppeared(dir, reservationPath, since) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  const reservation = path.resolve(reservationPath);
  return names.some((name) => {
    if (!HOLDER_NAME.test(name) || path.resolve(dir, name) === reservation) {
      return false;
    }
    try {
      const holder = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
      return holder.v === HOLDER_FORMAT && holder.retry === true && holder.priority === 'landed' && holder.since === since;
    } catch {
      return false; // 書きかけ・読めない・消えた
    }
  });
}

/**
 * intervalMs ごとに retryHolderAppeared を見て、見えたら reservation.release() を呼ぶ。予約のファイルが本当に無くなる
 * まで (release は unlink の失敗を飲み込むので、merge-pr 自身の unlink も同じ一過性で失敗しうる) 毎周呼び直し、
 * 無くなったら止まる。unlink が失敗し続ければ呼び出し元の finally が戻り値の stop を呼ぶまで続く (その後は finally の
 * release が最後の砦)。reservation は reserveVerifySlot の戻り値 ({ path, release })。path が無ければ何もしない。
 * 戻り値は監視を止める関数 (冪等)。監視の失敗は再実行を止めない。
 */
export function watchRetryHolder({ reservation, since, intervalMs }) {
  if (reservation.path === undefined) {
    return () => {};
  }
  const dir = path.dirname(reservation.path);
  const timer = setInterval(() => {
    try {
      if (retryHolderAppeared(dir, reservation.path, since)) {
        reservation.release();
      }
      if (!existsSync(reservation.path)) {
        clearInterval(timer); // 消えた (自分で消した・再実行が消した)。守るものは無い
      }
    } catch {
      /* 次の周で見る */
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
