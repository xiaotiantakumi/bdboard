// bdboard-d48: `npm run verify` の同時実行本数をマシン単位で制限する実行スロット。
//
// 背景: 2026-08-18 の実機計測 (10コア/32GB) で verify が6本同時に走り、オーバー
// サブスクリプションが自己増幅して load average 190〜258 が数時間続いた。1本あたりの
// vitest ワーカーキャップ (bdboard-255) だけでは投入本数が増えると同じ状態に戻るため、
// 同時実行本数そのものに上限 (既定2) を設ける。
//
// 設計 (bd merge-slot との対比。詳細は docs/VERIFY.md「Verify slots」と bdboard-d48 notes):
// - merge-slot は「別コマンドを手順どおり叩く」純協調ロックで、実際に効くのは協力
//   不要のマージ直前 CAS だった。verify は全セッションの正規入口が `npm run verify`
//   (scripts/verify.mjs) の一本なので、ロックを入口自体に内蔵する。手順を覚える
//   必要がなく、規約どおり起動する限り自動で効く = CAS と同じ「協力不要」の性質。
// - 保護対象はローカルマシンの CPU/メモリなので、スロットの実体もローカルファイル
//   (os.tmpdir() 配下 = macOS ではユーザー毎の $TMPDIR、CI では /tmp) に置く。
//   bd bead 方式はクロスマシン可視だがここでは不要で、`bd ready` 汚染
//   (gt:slot ラベル除外の轍, bdboard-9k3) も acquire 忘れも起きない。
// - Lamport bakery 風のチケットキュー: 各プロセスが自 pid 名の holder file を作り、
//   (joinedAt, pid) 順で先着 slots 位以内に入ったら実行開始。FIFO なので待機者が
//   飢餓しない。これは負荷スロットルであり厳密な相互排除ではない (ほぼ同時参加の
//   極小レース窓で一瞬 slots+1 本になり得るが、settleMs で緩和済みかつ目的に対して
//   無害 — 防ぎたいのは6本級の積み上がりであって一瞬の3本目ではない)。
// - stale 処理: pid が死んだ holder は即回収 (SIGKILL された verify の後始末)。
//   pid が生きていて staleTtlMs を超えた holder は枠のカウントから外す (ハング1本が
//   枠を永久占有しない) が、ファイルは本人の後始末に任せて消さない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_SLOT_OPTIONS = Object.freeze({
  slots: 2,
  dir: path.join(os.tmpdir(), 'bdboard-verify-slots'),
  waitTimeoutMs: 15 * 60_000,
  staleTtlMs: 30 * 60_000,
  pollMs: 2_000,
  settleMs: 150,
  statusIntervalMs: 10_000,
});

export class SlotWaitTimeoutError extends Error {}

function parseIntegerEnv(value) {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// env からの上書き。テストと緊急脱出ハッチ用であり、並列本数を増やす目的での常用は
// しない (docs/VERIFY.md「Verify slots」参照)。
export function envSlotOptions(env = process.env) {
  const options = {};
  const slots = parseIntegerEnv(env.BDBOARD_VERIFY_SLOTS);
  if (slots !== undefined) {
    options.slots = slots;
  }
  if (env.BDBOARD_VERIFY_SLOT_DIR) {
    options.dir = env.BDBOARD_VERIFY_SLOT_DIR;
  }
  const waitTimeoutMs = parseIntegerEnv(env.BDBOARD_VERIFY_SLOT_WAIT_MS);
  if (waitTimeoutMs !== undefined) {
    options.waitTimeoutMs = waitTimeoutMs;
  }
  return options;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 存在するが権限がない (同一ユーザーの $TMPDIR 運用ではまず出ないが、
    // 出た場合は「生きている」に倒す方が安全)。
    return error.code === 'EPERM';
  }
}

function holderPath(dir, pid) {
  return path.join(dir, `holder-${pid}.json`);
}

function readHolder(filePath) {
  try {
    const holder = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (typeof holder.pid !== 'number' || typeof holder.joinedAt !== 'number') {
      return null;
    }
    return holder;
  } catch {
    return null;
  }
}

function unlinkQuietly(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* already gone */
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// スロットを1つ獲得する。空きが出るまで FIFO で待ち、waitTimeoutMs を超えたら
// SlotWaitTimeoutError を投げる。戻り値の release() は冪等。process 'exit' でも
// 自動 release するので、呼び出し側が process.exit() する経路でも holder は残らない
// (SIGKILL だけは残るが、それは次の参加者の dead-pid 回収が拾う)。
export async function acquireVerifySlot(overrides = {}, log = (line) => console.error(line)) {
  const options = { ...DEFAULT_SLOT_OPTIONS, ...overrides };
  const { slots, dir } = options;
  if (slots <= 0) {
    log('verify: slot gating disabled (slots <= 0)');
    return { release: () => {} };
  }

  fs.mkdirSync(dir, { recursive: true });
  const selfPath = holderPath(dir, process.pid);
  const holder = { pid: process.pid, joinedAt: Date.now(), cwd: process.cwd() };
  const payload = JSON.stringify(holder);
  const writeSelf = () => fs.writeFileSync(selfPath, payload, { flag: 'wx' });
  try {
    writeSelf();
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
    // 同名ファイルが既にある = かつて同じ pid を使ったプロセスの残骸 (pid 再利用)。
    // 今この pid の持ち主は自分なので、置き換えてよい。
    unlinkQuietly(selfPath);
    writeSelf();
  }
  const onExit = () => unlinkQuietly(selfPath);
  process.on('exit', onExit);
  const release = () => {
    process.removeListener('exit', onExit);
    unlinkQuietly(selfPath);
  };

  try {
    // bakery 風 settle: ほぼ同時に並んだ相手の holder file がディスクに載るのを
    // 待ってから順位を読む (レースの完全排除ではなく、負荷スロットルとして十分な緩和)。
    await sleep(options.settleMs);
    let lastStatusAt = 0;
    let waited = false;
    const warnedStalePids = new Set();
    for (;;) {
      const active = [holder];
      let sawSelf = false;
      for (const name of fs.readdirSync(dir)) {
        if (!/^holder-\d+\.json$/.test(name)) {
          continue;
        }
        const filePath = path.join(dir, name);
        if (filePath === selfPath) {
          sawSelf = true;
          continue;
        }
        const entry = readHolder(filePath);
        if (entry === null) {
          unlinkQuietly(filePath); // 壊れたファイル
          continue;
        }
        if (!isProcessAlive(entry.pid)) {
          unlinkQuietly(filePath); // 死んだ保持者 (SIGKILL された verify 等) を回収
          continue;
        }
        if (Date.now() - entry.joinedAt > options.staleTtlMs) {
          if (!warnedStalePids.has(entry.pid)) {
            warnedStalePids.add(entry.pid);
            log(
              `verify: ignoring stale slot holder pid=${entry.pid}` +
                ` (in the queue > ${Math.round(options.staleTtlMs / 60_000)} min; not counting it toward the limit)`,
            );
          }
          continue;
        }
        active.push(entry);
      }
      if (!sawSelf) {
        // 自分の holder file が外的要因で消えた場合の自己修復 (他の参加者から見え続けるため)。
        try {
          writeSelf();
        } catch {
          /* 次周で再試行 */
        }
      }
      active.sort((a, b) => a.joinedAt - b.joinedAt || a.pid - b.pid);
      const rank = active.findIndex((entry) => entry.pid === process.pid);
      if (rank < slots) {
        if (waited) {
          log(`verify: slot acquired after ${Math.round((Date.now() - holder.joinedAt) / 1000)}s in queue`);
        }
        return { release };
      }
      waited = true;
      const waitedMs = Date.now() - holder.joinedAt;
      const holderPids = active.slice(0, slots).map((entry) => entry.pid).join(', ');
      if (waitedMs > options.waitTimeoutMs) {
        throw new SlotWaitTimeoutError(
          `verify: timed out after ${Math.round(waitedMs / 1000)}s waiting for a verify slot` +
            ` (slots=${slots}, holders: pid ${holderPids}).` +
            ` Investigate those pids (hung verify?) before retrying; do not disable the slot to get past this.`,
        );
      }
      if (Date.now() - lastStatusAt >= options.statusIntervalMs) {
        lastStatusAt = Date.now();
        log(
          `verify: waiting for a verify slot (queue position ${rank - slots + 1}/${active.length - slots},` +
            ` holders: pid ${holderPids}, waited ${Math.round(waitedMs / 1000)}s) — queueing, not a hang`,
        );
      }
      await sleep(options.pollMs);
    }
  } catch (error) {
    release();
    throw error;
  }
}
