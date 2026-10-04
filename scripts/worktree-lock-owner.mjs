// bdboard-wea0.1: worktree lock (scripts/worktree-lock.mjs) の助言用の中身 {by,pid,phase,sha,cwd,at} を読んで表示する。
// 中身は助言で、真実は flock の状態。読めない・壊れている中身は lock の動作に影響しない (設計 §3)。
// verify.mjs の import graph に入るので、古い Node でもパースできる構文に保つ (verify.mjs 冒頭の bdboard-eu2k)。
import fs from 'node:fs';

/** 助言用の持ち主。無い・空なら null、JSON の object でなければ { unreadable }。 */
export function readOwner(lockPath) {
  let line;
  try {
    line = fs.readFileSync(lockPath, 'utf8').split('\n')[0].trim();
  } catch {
    return null;
  }
  if (line === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(line);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    /* 下で unreadable として返す */
  }
  return { unreadable: line.slice(0, 200) };
}

export function describeOwner(owner) {
  if (owner === null) {
    return 'an unrecorded holder';
  }
  if (owner.unreadable !== undefined) {
    return `an unknown holder (owner unreadable: ${owner.unreadable})`;
  }
  const sha = typeof owner.sha === 'string' ? owner.sha.slice(0, 12) : '?';
  return `${owner.by} (pid ${owner.pid}, phase ${owner.phase}, sha ${sha}, since ${owner.at})`;
}

/** 推測なしに今の保持プロセスを示すコマンド (pgrep -g <pgid> の代わり)。 */
export function lsofHint(lockPath) {
  return `lsof -t '${lockPath.replace(/'/g, "'\\''")}'`;
}
