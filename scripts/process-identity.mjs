// bdboard-ky9l: プロセスの生存確認と「記録したのと同じプロセスか」の判定。
//
// 生存確認 (isProcessAlive) は、もとは scripts/merge-pr/finish.mjs の pidAlive と
// scripts/verify-slot-files.mjs の isProcessAlive の 2 か所に同じ中身で書かれていた。ここへ 1 つに
// まとめた。PID は再利用されるので、「kill(pid, 0) が通る」だけでは「記録を書いたプロセスがまだ居る」
// とは言えない。processStartTime / compareStartTime は、記録時のプロセス開始時刻と今の開始時刻を
// 比べて PID 再利用を見分ける (scripts/merge-pr/verifying-record.mjs が使う)。
//
// 制約: このファイルは scripts/verify.mjs → verify-slot.mjs → verify-slot-files.mjs から import される
// ので、古い Node でもパースできる構文・API に保つこと (bdboard-eu2k。目安の下限は v14.13.1)。
// `||=` / `??=` などの新しい構文と、`Array.prototype.at` / `Object.hasOwn` / `structuredClone` 等の
// v14 に無い API を使わない。`?.` / `??` も、同じ判定を書いている verify-slot-files.mjs に合わせて避ける。
import { spawnSync } from 'node:child_process';

// ps の開始時刻 (lstart) は秒単位で、Linux の procps はブート時刻 (/proc/stat の btime) から逆算するため
// NTP 補正やサスペンド明けに 1 秒前後ずれうる。この幅までは同じプロセスとみなす。PID が再利用されて
// 別のプロセスがこの幅の中に開始するには、元のプロセスが死んでから PID が一周する必要があり、
// 現実には起きない。
export const START_TIME_TOLERANCE_MS = 30_000;

const PS_TIMEOUT_MS = 5_000;

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * pid のプロセスが居るか。EPERM は「居るが触れない」なので居る側に倒す (同一ユーザーの運用ではまず
 * 出ないが、出たときに「居ない」と誤って記録を回収するより安全)。pid が正の整数でなければ false
 * (process.kill(0, 0) は自分のプロセスグループ宛てで成功してしまうため、ここで弾く)。
 */
export function isProcessAlive(pid) {
  if (!isPositiveInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM';
  }
}

/**
 * pgid をリーダーとするプロセスグループにまだ何か居るか (POSIX)。ESRCH だけを「空」とみなす。
 * win32 にはプロセスグループが無い (process-tree.mjs と同じ事情) ので常に false。
 */
export function isProcessGroupAlive(pgid, deps) {
  const platform = (deps && deps.platform) || process.platform;
  if (platform === 'win32' || !isPositiveInteger(pgid)) {
    return false;
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return !(Boolean(error) && error.code === 'ESRCH');
  }
}

// ps の出力 ("Sat Oct  4 12:00:00 2026" 形式、UTC で取る) を ISO 8601 にする。読めなければ空白を
// 畳んだ元の文字列を返す (同じ関数で記録も比較もするので、形式が混ざらない限り等値比較に使える)。
function normalizeStartTime(text) {
  const collapsed = String(text).replace(/\s+/g, ' ').trim();
  if (collapsed === '') {
    return null;
  }
  const parsed = Date.parse(collapsed + ' UTC');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : collapsed;
}

/**
 * pid のプロセス開始時刻 (ISO 8601 の文字列)。取れなければ null。
 *
 * POSIX: `ps -p <pid> -o lstart=`。LC_ALL=C・TZ=UTC で呼び、ロケールやタイムゾーンの違う環境で
 * 同じプロセスの文字列が変わらないようにする。ps が無い・-p/-o lstart= を解さない (busybox 等)・
 * pid が居ない・タイムアウトのときは null。
 * win32: ps が無いので常に null (呼び出し側は「判定できない」として時間切れ判定にフォールバックする。
 * PowerShell の Get-Process で取る手もあるが、起動が遅く、この環境では確かめられないので入れていない)。
 *
 * deps はテストの差し替え口 ({ platform, spawnSync })。
 */
export function processStartTime(pid, deps) {
  const options = deps || {};
  const platform = options.platform || process.platform;
  if (platform === 'win32' || !isPositiveInteger(pid)) {
    return null;
  }
  const spawn = options.spawnSync || spawnSync;
  let result;
  try {
    result = spawn('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { LC_ALL: 'C', TZ: 'UTC' }),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PS_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  if (!result || result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    return null;
  }
  return normalizeStartTime(result.stdout);
}

/**
 * 記録した開始時刻 recorded と、pid の今の開始時刻を比べる。
 *   'same'      — 同じプロセス (START_TIME_TOLERANCE_MS 以内)
 *   'different' — 別のプロセス = PID が再利用されている
 *   'unknown'   — 判定できない (記録が無い・旧形式 / 今の開始時刻を取れない / 片方だけ日時として読めて
 *                 形式が食い違う)
 * 'unknown' を 'different' に倒さないこと: 判定できないだけで「別のプロセス」とみなすと、本当に
 * 走っている finish / verify の裏で 2 本目が並走する。
 */
export function compareStartTime(pid, recorded, deps) {
  if (typeof recorded !== 'string' || recorded === '') {
    return 'unknown';
  }
  const current = processStartTime(pid, deps);
  if (current === null) {
    return 'unknown';
  }
  const recordedMs = Date.parse(recorded);
  const currentMs = Date.parse(current);
  if (Number.isFinite(recordedMs) && Number.isFinite(currentMs)) {
    return Math.abs(currentMs - recordedMs) <= START_TIME_TOLERANCE_MS ? 'same' : 'different';
  }
  if (Number.isFinite(recordedMs) !== Number.isFinite(currentMs)) {
    return 'unknown'; // 片方は日時・片方は読めない生の文字列: 同じプロセスかを決める材料にならない
  }
  return current === recorded ? 'same' : 'different';
}
