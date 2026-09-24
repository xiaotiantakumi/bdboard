// bdboard-ulxa.6: verify スロット (verify-slot.mjs) の holder file の読み書き。
// verify.mjs の import graph に入るので、古い Node でもパースできる構文に保つこと (bdboard-eu2k)。
import fs from 'node:fs';
import path from 'node:path';

// 書きかけ (旧スクリプトの非原子的な書き込み) を壊れたファイルと取り違えて消さないための猶予。
const CORRUPT_GRACE_MS = 5_000;

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

export function unlinkQuietly(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* already gone */
  }
}

function isOlderThan(filePath, ms) {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs > ms;
  } catch {
    return false;
  }
}

// 一時ファイルに書いてから rename する (読み手が書きかけを「壊れたファイル」として消さないように)。
// 一時ファイル名は holder-<pid>.json に一致しないので、新旧どちらの読み手にも無視される。
export function writeHolderAtomically(filePath, holder) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(holder));
  fs.renameSync(temporary, filePath);
}

/** 自分以外の holder を読む。死んだ pid と、書きかけでないと言える壊れたファイルは回収する。 */
export function readOthers(dir, selfPath) {
  const others = [];
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
      if (isOlderThan(filePath, CORRUPT_GRACE_MS)) {
        unlinkQuietly(filePath); // 壊れたファイル
      }
      continue;
    }
    if (!isProcessAlive(entry.pid)) {
      unlinkQuietly(filePath); // 死んだ保持者 (SIGKILL された verify 等) を回収
      continue;
    }
    others.push(entry);
  }
  return { others, sawSelf };
}
