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
// - bdboard-xdk8: landed (着地後検証) は pr (PR 前の手元 verify) と同時に走らない (merge とは枠を分け合い、
//   止まった先頭を飛ばせるのも merge だけ)。負荷で着地後検証が偽の failure を出し、main-broken の枠で全マージが
//   止まったため。規則と根拠は verify-slot-queue.mjs の EXCLUDED_BESIDE。この規則で止まっている待ちは、相手が
//   stale になるまで打ち切りを延ばす (verify-slot-wait.mjs の slotWaitLimitMs。明示した
//   BDBOARD_VERIFY_SLOT_WAIT_MS が優先)。走っている landed を待つ側の表示は「正常、kill しない」にする (旧表示の
//   「hung verify?」は kill を誘っていた)。merge-pr が着地後検証を 1 回だけ再実行するときの隙間は予約 holder で
//   埋める (reserveVerifySlot / handoffPath)。verify.mjs はこの verify の素性の env をリーダーに渡さない
//   (withoutSlotIdentity)。
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
import { EXCLUDED_BESIDE, HOLDER_FORMAT, MAX_SENIORITY_MS, normalizePriority, planSlots, TIER_STEP_MS } from './verify-slot-queue.mjs';
import { slotWaitLimitMs, timeoutMessage, waitStatusLine } from './verify-slot-wait.mjs';

export { slotWaitLimitMs };

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
  excludedBeside: EXCLUDED_BESIDE,
  handoffPath: undefined,
  waitTimeoutFromEnv: false,
});

// bdboard-xdk8: verify スロットでの「この verify は誰か」を表す env (merge-pr が契約の verify に渡す)。verify.mjs は
// リーダー (verify:steps → vitest のワーカー) に渡す env からこれを外す: 受け継ぐと、テストの中で起こす verify.mjs や
// スロットのスクリプトが外側の landed の優先度・並んだ時刻・予約を名乗ってしまう (landed の待ちの延長で、
// スロット待ちの打ち切りのテストが 32 分待って落ちた。PR #855 のレビュー)。
export const SLOT_IDENTITY_ENV = Object.freeze(['BDBOARD_VERIFY_PRIORITY', 'BDBOARD_VERIFY_QUEUE_SINCE', 'BDBOARD_VERIFY_SLOT_HANDOFF']);

export function withoutSlotIdentity(env = process.env) {
  const copy = { ...env };
  for (const name of SLOT_IDENTITY_ENV) {
    delete copy[name];
  }
  return copy;
}

// bdboard-72oy: verify 本体内の vitest を単発実行と区別する。スロット identity ではないため引き継ぐ。
export const IN_VERIFY_ENV = 'BDBOARD_IN_VERIFY';

export class SlotWaitTimeoutError extends Error {}

// bdboard-wj9m: スロット待ちの打ち切りで `npm run verify` (scripts/verify.mjs) が返す終了コード。
// 「verify が落ちた」(1 ほか) と区別するための予約値で、EX_TEMPFAIL (75、merge-pr の EXIT.RETRY と
// 同じ慣習) = あとで再試行すればよい一時的な失敗。merge-pr の着地後検証 (landed-verify.mjs) は
// これを main の破損 (台帳への failure) ではなく「検証を実行できなかった」(error) として扱う。
// 予約を守るため、verify.mjs は本体ステップが偶然 75 で終わっても 1 に丸めて返す。
export const SLOT_WAIT_TIMEOUT_EXIT_CODE = 75;

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
    options.waitTimeoutFromEnv = true; // 明示した値は landed 等の延長より優先する (slotWaitLimitMs)
  }
  if (env.BDBOARD_VERIFY_PRIORITY) {
    options.priority = normalizePriority(env.BDBOARD_VERIFY_PRIORITY);
  }
  const queueSince = parseIntegerEnv(env.BDBOARD_VERIFY_QUEUE_SINCE);
  if (queueSince !== undefined) {
    options.queueSince = queueSince;
  }
  if (env.BDBOARD_VERIFY_SLOT_HANDOFF) {
    options.handoffPath = env.BDBOARD_VERIFY_SLOT_HANDOFF; // merge-pr の予約 holder (reserveVerifySlot)
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function newHolder(options) {
  const joinedAt = Date.now();
  const holder = { v: HOLDER_FORMAT, pid: process.pid, joinedAt, queuedAt: joinedAt, cwd: process.cwd(), priority: normalizePriority(options.priority) };
  if (options.reserved) {
    holder.reserved = true; // reserveVerifySlot の予約 (landed なら since を頭打ちにしない。verify-slot-queue.mjs)
  }
  if (options.retry) {
    holder.retry = true; // 予約を引き継いだ再実行 (同上)
  }
  if (typeof options.queueSince === 'number' && Number.isFinite(options.queueSince)) {
    holder.since = Math.min(options.queueSince, holder.joinedAt);
  }
  return holder;
}

// スロットを1つ獲得する。順番が来るまで待ち、走っている holder の顔ぶれが waitTimeoutMs (landed は
// slotWaitLimitMs) の間変わらなければ SlotWaitTimeoutError を投げる。戻り値の release() は冪等。process 'exit' でも
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
  const handoff = isHandoffPath(options.handoffPath, dir, selfPath) ? options.handoffPath : undefined;
  let holder = newHolder({ ...options, retry: handoff !== undefined });
  // 同名ファイルが既にある = かつて同じ pid を使ったプロセスの残骸 (pid 再利用)。
  // 今この pid の持ち主は自分なので、rename で置き換えてよい。
  await writeHolderAtomically(selfPath, holder, { io: options.io });
  const onExit = () => unlinkQuietly(selfPath);
  process.on('exit', onExit);
  const release = () => {
    process.removeListener('exit', onExit);
    unlinkQuietly(selfPath);
  };
  // bdboard-xdk8: 自分の holder が見えるようになったので、最初の settle より前に merge-pr の予約 holder
  // (reserveVerifySlot) を消す。消せなくても自分の順番の計算からは外す (予約は自分の席なので、その後ろで待たない)。
  const skipPid = handoff === undefined ? null : releaseHandoff(handoff, options, log);

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
      const { others: seen, sawSelf } = readOthers(dir, selfPath, { io: options.io, unreadableSince });
      const others = skipPid === null ? seen : seen.filter((entry) => entry.pid !== skipPid);
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
        // acquiredAt の rename が一時的な errno で再試行中 (最大 630ms 程度) は、他の待ち手からは
        // まだ acquiredAt の無い holder = 待っている側に見える。その間隔で優先度の高い新参が
        // 割り込むと一瞬 slots+1 本になりうるが、そもそもこのスロットは厳密な排他ではなく負荷の
        // 間引きなので許容する (ファイル冒頭のコメント参照)。読めない相手はどのみち「走っている」に
        // 倒しているのと同じ向き。
        await writeHolderAtomically(selfPath, { ...holder, acquiredAt: Date.now() }, { io: options.io });
        if (waited) {
          log(`verify: slot acquired after ${Math.round((Date.now() - holder.queuedAt) / 1000)}s in queue (priority ${holder.priority})`);
        }
        return { release };
      }
      waited = true;
      const key = plan.running.map((entry) => entry.pid).sort((a, b) => a - b).join(',');
      if (key !== runningKey) {
        runningKey = key;
        progressAt = now;
      }
      if (now - progressAt > slotWaitLimitMs(holder.priority, options, plan)) {
        throw new SlotWaitTimeoutError(timeoutMessage(plan, options, now - progressAt));
      }
      if (now - lastStatusAt >= options.statusIntervalMs) {
        lastStatusAt = now;
        log(waitStatusLine(plan, holder, options, now));
      }
      await sleep(options.pollMs);
    }
  } catch (error) {
    release();
    throw error;
  }
}

// 予約 holder の path として受け取ってよいか: 同じスロットの置き場にある holder file で、自分のものではない
// (env から来た path で、無関係なファイルや自分の holder を消さないため)。
export function isHandoffPath(handoffPath, dir, selfPath) {
  return (
    typeof handoffPath === 'string' &&
    path.resolve(handoffPath) !== path.resolve(selfPath) &&
    path.resolve(path.dirname(handoffPath)) === path.resolve(dir) &&
    /^holder-\d+\.json$/.test(path.basename(handoffPath))
  );
}

// 予約を消し、その pid を返す (自分の順番の計算から外す)。既に無い (ENOENT) のは正常。消せないときは黙らずに書く:
// 予約は merge-pr が再実行の後で消すまで残り、その間ほかの待ち手からは landed の待ち手に見える。
function releaseHandoff(handoffPath, options, log) {
  try {
    (options.io || fs).unlinkSync(handoffPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log(`verify: warning: could not remove the landed retry reservation ${handoffPath} (${error.code || error.message}); going on without waiting behind it — merge-pr removes it when the retry ends`);
    }
  }
  return Number(/^holder-(\d+)\.json$/.exec(path.basename(handoffPath))[1]);
}

/**
 * bdboard-xdk8: 予約 holder を置く (自分の pid で並ぶだけで、走らない)。merge-pr が着地後検証を 1 回だけ
 * 再実行するとき、1 回目の verify が抜けてから再実行の verify が自分の holder を書くまでの数秒〜十数秒に、
 * 待っていた pr が枠を取らないため (予約は landed の待ち手として並び、pr はその後ろで止まる)。overrides は
 * acquireVerifySlot と同じ (priority / queueSince / dir / slots)。再実行の verify には BDBOARD_VERIFY_SLOT_HANDOFF
 * で path を渡し、verify は自分の holder を書いた後で予約を消す。戻り値の release() は冪等で、process 'exit'
 * でも消す。SIGKILL で残っても、pid が死んでいれば次の参加者の readOthers が回収する。スロットが無効
 * (slots <= 0) なら何も書かない (path は undefined)。
 */
export async function reserveVerifySlot(overrides = {}) {
  const options = { ...DEFAULT_SLOT_OPTIONS, ...overrides };
  if (options.slots <= 0) {
    return { path: undefined, release: () => {} };
  }
  fs.mkdirSync(options.dir, { recursive: true });
  const selfPath = holderPath(options.dir, process.pid);
  await writeHolderAtomically(selfPath, newHolder({ ...options, reserved: true }), { io: options.io });
  const onExit = () => unlinkQuietly(selfPath);
  process.on('exit', onExit);
  return {
    path: selfPath,
    release: () => {
      process.removeListener('exit', onExit);
      unlinkQuietly(selfPath);
    },
  };
}
