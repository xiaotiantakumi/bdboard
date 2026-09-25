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
//   順番が来たら実行開始。これは負荷スロットルであり厳密な相互排除ではない (ほぼ同時参加の
//   極小レース窓で一瞬 slots+1 本になり得るが、settleMs で緩和済みかつ目的に対して
//   無害 — 防ぎたいのは6本級の積み上がりであって一瞬の3本目ではない)。
// - bdboard-ulxa.6: 順番は FIFO から「優先度 + 仮想到着時刻」に変えた (landed > merge > pr、
//   上限本数は不変)。決め方と旧形式の holder との混在の扱いは verify-slot-queue.mjs。
//   走り出すときに holder file へ acquiredAt を書く (書き込みは一時ファイル + rename で原子的に)。
// - stale 処理: pid が死んだ holder は即回収 (SIGKILL された verify の後始末)。
//   pid が生きていて staleTtlMs を超えた holder は枠のカウントから外す (ハング1本が
//   枠を永久占有しない) が、ファイルは本人の後始末に任せて消さない。
// - 読み取り自体が失敗した holder (Windows で相手の置き換え rename と競合した EPERM / EBUSY 等) は、
//   pid が生きていれば走っているとみなして数え、ファイルの mtime から staleTtlMs で外す (bdboard-wt5c。
//   書きかけ = パースできないファイルは従来どおり数えない)。詳細は verify-slot-files.mjs。
// - 待ちの打ち切り (waitTimeoutMs) は「走っている holder の顔ぶれが変わらないまま」の時間で
//   測る (bdboard-ulxa.6)。優先度があると下位の待ちは合計では長くなりうるが、列が進んでいる
//   限りハングではないため。読めない holder (下の bdboard-wt5c) が一瞬だけ顔ぶれに入ると測り直しに
//   なるが、打ち切りが遅れる向きにしか働かない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { holderPath, readOthers, unlinkQuietly, writeHolderAtomically } from './verify-slot-files.mjs';
import { HOLDER_FORMAT, MAX_SENIORITY_MS, normalizePriority, planSlots, TIER_STEP_MS } from './verify-slot-queue.mjs';

export const DEFAULT_SLOT_OPTIONS = Object.freeze({
  slots: 2,
  dir: path.join(os.tmpdir(), 'bdboard-verify-slots'),
  waitTimeoutMs: 15 * 60_000,
  staleTtlMs: 30 * 60_000,
  pollMs: 2_000,
  settleMs: 150,
  statusIntervalMs: 10_000,
  priority: 'pr',
  queueSince: undefined,
  tierStepMs: TIER_STEP_MS,
  maxSeniorityMs: MAX_SENIORITY_MS,
});

export class SlotWaitTimeoutError extends Error {}

function parseIntegerEnv(value) {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// env からの上書き。スロット数・置き場・待ち時間はテストと緊急脱出ハッチ用であり、並列本数を
// 増やす目的での常用はしない (docs/VERIFY.md「Verify slots」参照)。優先度 (BDBOARD_VERIFY_PRIORITY)
// と並んだ時刻 (BDBOARD_VERIFY_QUEUE_SINCE) は merge-pr が着地予定ツリー / 着地後検証に渡す。
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
  if (env.BDBOARD_VERIFY_PRIORITY) {
    options.priority = normalizePriority(env.BDBOARD_VERIFY_PRIORITY);
  }
  const queueSince = parseIntegerEnv(env.BDBOARD_VERIFY_QUEUE_SINCE);
  if (queueSince !== undefined) {
    options.queueSince = queueSince;
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function newHolder(options) {
  const joinedAt = Date.now();
  const holder = { v: HOLDER_FORMAT, pid: process.pid, joinedAt, queuedAt: joinedAt, cwd: process.cwd(), priority: normalizePriority(options.priority) };
  if (typeof options.queueSince === 'number' && Number.isFinite(options.queueSince)) {
    holder.since = Math.min(options.queueSince, holder.joinedAt);
  }
  return holder;
}

// スロットを1つ獲得する。順番が来るまで待ち、走っている holder の顔ぶれが waitTimeoutMs の間
// 変わらなければ SlotWaitTimeoutError を投げる。戻り値の release() は冪等。process 'exit' でも
// 自動 release するので、呼び出し側が process.exit() する経路でも holder は残らない
// (SIGKILL だけは残るが、それは次の参加者の dead-pid 回収が拾う)。overrides.io は他の holder を
// 読む/自分の holder file を書く fs の差し替え口 (テストの失敗注入用。既定は node:fs)。自分の
// 書き込み (acquiredAt 等) の rename が一時的な errno で失敗しても writeHolderAtomically が
// 短く再試行する (bdboard-smyp、verify-slot-files.mjs)。
export async function acquireVerifySlot(overrides = {}, log = (line) => console.error(line)) {
  const options = { ...DEFAULT_SLOT_OPTIONS, ...overrides };
  const { slots, dir } = options;
  if (slots <= 0) {
    log('verify: slot gating disabled (slots <= 0)');
    return { release: () => {} };
  }

  fs.mkdirSync(dir, { recursive: true });
  const selfPath = holderPath(dir, process.pid);
  let holder = newHolder(options);
  // 同名ファイルが既にある = かつて同じ pid を使ったプロセスの残骸 (pid 再利用)。
  // 今この pid の持ち主は自分なので、rename で置き換えてよい。
  await writeHolderAtomically(selfPath, holder, { io: options.io });
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
    let runningKey = null;
    let progressAt = Date.now();
    const warnedStalePids = new Set();
    const unreadableSince = new Map(); // 読めない相手の年齢 (bdboard-wt5c、verify-slot-files.mjs)
    for (;;) {
      const { others, sawSelf } = readOthers(dir, selfPath, { io: options.io, unreadableSince });
      if (!sawSelf) {
        // 自分の holder file が外的要因で消えた場合の自己修復 (他の参加者から見え続けるため)。
        try {
          await writeHolderAtomically(selfPath, holder, { io: options.io });
        } catch {
          /* 次周で再試行 */
        }
      }
      const now = Date.now();
      if (now - holder.joinedAt > options.staleTtlMs / 2) {
        // 他の holder から stale と見なされる前に並び直す (順番は queuedAt で保つ)。
        const refreshed = { ...holder, joinedAt: now };
        try {
          await writeHolderAtomically(selfPath, refreshed, { io: options.io });
          holder = refreshed; // 書けたときだけ (他の holder から見える joinedAt と揃える)
        } catch {
          /* 次周で再試行 (書けていない間は planSlots が自分を stale の年齢として取らせない) */
        }
      }
      const plan = planSlots([holder, ...others], { ...options, selfPid: process.pid, now });
      for (const entry of plan.stale) {
        if (!warnedStalePids.has(entry.pid)) {
          warnedStalePids.add(entry.pid);
          log(
            `verify: ignoring stale slot holder pid=${entry.pid}` +
              ` (in the queue > ${Math.round(options.staleTtlMs / 60_000)} min; not counting it toward the limit)`,
          );
        }
      }
      if (plan.acquire) {
        await writeHolderAtomically(selfPath, { ...holder, acquiredAt: Date.now() }, { io: options.io });
        if (waited) {
          log(`verify: slot acquired after ${Math.round((Date.now() - holder.queuedAt) / 1000)}s in queue (priority ${holder.priority})`);
        }
        return { release };
      }
      waited = true;
      const holderPids = plan.running.map((entry) => entry.pid).join(', ');
      const key = plan.running.map((entry) => entry.pid).sort((a, b) => a - b).join(',');
      if (key !== runningKey) {
        runningKey = key;
        progressAt = now;
      }
      if (now - progressAt > options.waitTimeoutMs) {
        throw new SlotWaitTimeoutError(
          `verify: timed out after ${Math.round((now - progressAt) / 1000)}s without progress waiting for a verify slot` +
            ` (slots=${slots}, holders: pid ${holderPids}).` +
            ` Investigate those pids (hung verify?) before retrying; do not disable the slot to get past this.`,
        );
      }
      if (now - lastStatusAt >= options.statusIntervalMs) {
        lastStatusAt = now;
        log(
          `verify: waiting for a verify slot (queue position ${plan.position}/${plan.queue.length}, priority ${holder.priority},` +
            ` holders: pid ${holderPids}, waited ${Math.round((now - holder.queuedAt) / 1000)}s) — queueing, not a hang`,
        );
      }
      await sleep(options.pollMs);
    }
  } catch (error) {
    release();
    throw error;
  }
}
