// bdboard-ulxa.6: verify スロット (verify-slot.mjs) の holder file の読み書き。
// verify.mjs の import graph に入るので、古い Node でもパースできる構文に保つこと (bdboard-eu2k)。
import fs from 'node:fs';
import path from 'node:path';

import { HOLDER_FORMAT } from './verify-slot-queue.mjs';

// 書きかけ (旧スクリプトの非原子的な書き込み) を壊れたファイルと取り違えて消さないための猶予。
// 中身がパースできないファイルだけに使う。読み取り自体が失敗したファイルには使わない (下の readOthers)。
const CORRUPT_GRACE_MS = 5_000;

const HOLDER_NAME = /^holder-(\d+)\.json$/;
const GONE = 'gone';
const UNREADABLE = 'unreadable';
const CORRUPT = 'corrupt';

// bdboard-smyp: writeHolderAtomically の rename が一時的な errno で失敗したときに再試行する回数と
// 待ち時間 (ms)。合計は 1 秒未満 (10+20+40+80+160+320 = 630ms)。これを使い切ってもまだ失敗するなら
// 一時的な競合ではないとみなし、これまでどおり例外を投げる (呼び出し元の acquireVerifySlot が
// スロットを release する)。
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320];
// Windows で「相手が置き換え中のファイルへの rename」が失敗するときの errno (bdboard-wt5c の
// readHolder と同じ集合)。それ以外 (ENOENT など) は一時的な競合ではないので再試行しない。
const RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);

const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

export function holderPath(dir, pid) {
  return path.join(dir, `holder-${pid}.json`);
}

// bdboard-wt5c: 「読み取り自体の失敗」と「中身が holder として読めない (書きかけ・壊れた)」を分ける。
// Windows では相手の置き換え rename (writeHolderAtomically) と競合した読み取りが EPERM / EBUSY /
// EACCES で失敗する。これを書きかけと同じに扱うと、その周だけ相手が見えず上限 +1 本が走りうる
// (待ち手が acquiredAt を書く rename と競合すると、走り出した相手を数え損ねる)。ENOENT は相手が
// release して消えた。
function readHolder(io, filePath) {
  let text;
  try {
    text = io.readFileSync(filePath, 'utf8');
  } catch (error) {
    return error && error.code === 'ENOENT' ? GONE : UNREADABLE;
  }
  try {
    const holder = JSON.parse(text);
    if (holder !== null && typeof holder.pid === 'number' && typeof holder.joinedAt === 'number') {
      return holder;
    }
  } catch {
    /* 下で CORRUPT */
  }
  return CORRUPT;
}

export function unlinkQuietly(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* already gone */
  }
}

function isOlderThan(io, filePath, ms, now) {
  try {
    return now - io.statSync(filePath).mtimeMs > ms;
  } catch {
    return false;
  }
}

// 読めなかった相手の代わりに数える holder。中身が分からないので「走っている」とみなす (上限を
// 超えない側に倒す)。年齢はファイルの mtime (走っている holder が最後に書いたのは acquiredAt なので、
// planSlots の「acquiredAt から staleTtlMs で外す」とそのまま揃う)。stat も失敗したら、この呼び出し元が
// 最初に読めなかった時刻 (unreadableSince) を使う。どちらでも、読めないまま staleTtlMs を過ぎた残骸は
// stale として数から外れ、枠を永久には塞がない (stat も失敗する場合の年齢は呼び出し元ごとなので、新しく
// 並んだ verify はそれぞれ最大 staleTtlMs まで 1 枠を差し引く。Windows でその状態になるのは削除待ちの
// 一瞬だけ)。代わりの holder は旧形式の待ち手の barrier (verify-slot-queue.mjs) にはならない: 旧スクリプトは
// holder を一度 'wx' で書くだけで rename しないので、旧形式が読めなくなるのはウイルス対策ソフトの
// ロックなどの稀な場合に限られ、そのときも数としては「走っている」側に倒している。
function unreadableHolder(io, filePath, pid, now, unreadableSince) {
  if (!unreadableSince.has(filePath)) {
    unreadableSince.set(filePath, now);
  }
  let since = unreadableSince.get(filePath);
  try {
    since = io.statSync(filePath).mtimeMs;
  } catch {
    /* 最初に読めなかった時刻のまま */
  }
  return { v: HOLDER_FORMAT, pid, joinedAt: since, queuedAt: since, acquiredAt: since, unreadable: true };
}

// 一時ファイルに書いてから rename する (読み手が書きかけを「壊れたファイル」として消さないように)。
// 一時ファイル名は holder-<pid>.json に一致しないので、新旧どちらの読み手にも無視される。
//
// bdboard-smyp: Windows では、自分の acquiredAt 書き込み (rename) が、たまたま同じ瞬間に相手が
// この holder file を読んでいる操作 (アンチウイルスのスキャン等、ファイルを一時的に開く何か) と
// 競合すると MoveFileEx が ERROR_ACCESS_DENIED (EPERM/EBUSY/EACCES) を返しうる (未検証。CI の直近
// 実績では再現なし — 直近の verify-windows run に同種の失敗は見当たらない。bdboard-wt5c fable
// レビュー指摘6)。起きても一瞬の競合のはずなので、読み手側 (readHolder) と対称に、短く・上限
// 付きで再試行してから諦める。options.io / options.wait はテストの差し替え口 (既定は node:fs /
// 実タイマー)。
export async function writeHolderAtomically(filePath, holder, options = {}) {
  const io = options.io || fs;
  const wait = options.wait || defaultWait;
  const temporary = `${filePath}.${process.pid}.tmp`;
  io.writeFileSync(temporary, JSON.stringify(holder));
  for (let attempt = 0; ; attempt += 1) {
    try {
      io.renameSync(temporary, filePath);
      return;
    } catch (error) {
      const code = error && error.code;
      if (!RENAME_RETRY_ERRNOS.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        throw error; // 対象外の errno、または再試行の上限に達した — 今までどおり呼び出し元に投げる
      }
      await wait(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * 自分以外の holder を読む。死んだ pid と、書きかけでないと言える壊れたファイルは回収する。
 * 読み取り自体が失敗した相手は、pid (ファイル名から) が生きていれば「走っている」として数える
 * (unreadableHolder)。options.io はテストの失敗注入用 (既定は node:fs)。options.unreadableSince は
 * 呼び出し元が周をまたいで持つ Map (stat も失敗した相手の年齢を数えるため)。
 */
export function readOthers(dir, selfPath, options = {}) {
  const io = options.io || fs;
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const unreadableSince = options.unreadableSince || new Map();
  const others = [];
  let sawSelf = false;
  const names = io.readdirSync(dir);
  for (const filePath of [...unreadableSince.keys()]) {
    if (!names.includes(path.basename(filePath))) {
      unreadableSince.delete(filePath); // 消えた相手の記録を持ち越さない
    }
  }
  for (const name of names) {
    const match = HOLDER_NAME.exec(name);
    if (match === null) {
      continue;
    }
    const filePath = path.join(dir, name);
    if (filePath === selfPath) {
      sawSelf = true;
      continue;
    }
    const entry = readHolder(io, filePath);
    if (entry !== UNREADABLE) {
      unreadableSince.delete(filePath);
    }
    if (entry === GONE) {
      continue; // readdir の後に release された
    }
    if (entry === CORRUPT) {
      if (isOlderThan(io, filePath, CORRUPT_GRACE_MS, now)) {
        unlinkQuietly(filePath); // 壊れたファイル
      }
      continue;
    }
    const pid = entry === UNREADABLE ? Number(match[1]) : entry.pid;
    if (!isProcessAlive(pid)) {
      unlinkQuietly(filePath); // 死んだ保持者 (SIGKILL された verify 等) を回収。読めない残骸も同じ
      continue;
    }
    // 読めない相手は消さない (生きている holder の置き換え途中でありうる)。
    others.push(entry === UNREADABLE ? unreadableHolder(io, filePath, pid, now, unreadableSince) : entry);
  }
  return { others, sawSelf };
}
