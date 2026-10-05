// bdboard-wea0.1: worktree 単位の advisory lock (flock(2))。設計は `bd show bdboard-wea0` の DESIGN 欄 (§2–§5)。
// <absolute-git-dir>/bdboard-worktree.lock に flock を取る。Node は flock を呼べないので、Node が openSync した
// fd を子の fd 3 に渡し、1 行のヘルパー (perl / python3) にその fd を flock させる。flock の lock は「開いた
// ファイル記述」に付くため、ヘルパーが終わっても lock は Node の記述に残り、その fd を受け継いだ子 (verify の
// リーダー) が生きている間も残る (E1 / S4)。最後の保持者が死ねばカーネルが外す: PID・時計・年齢は入力にならない。
// 実測から来る決まり (設計 §2):
// - 1 プロセス 1 記述子。同じプロセスでも 2 つ目の記述は 1 つ目と衝突する (E1)。開き直さない。
// - ファイルは絶対に unlink しない。消して作り直されると、別の inode に 2 人目の EX が立つ (E5)。取得のたびに
//   fstat(fd) と stat(path) の dev+ino を比べ、違えば開き直して取り直す。
// - release で fd を null にし以後の操作は拒否する。閉じた fd 番号への flock が、番号を再利用した spawnSync の pipe
//   に効いて 0 を返した (Linux, E11)。
// - 変換 (EX→SH / SH→EX) は原子的でない (E4: macOS は降格、Linux は昇格の隙間に他者が入る)。拒否は結果として
//   返し、黙らない。拒否のあとは記述を UN して「何も持っていない」に揃える (OS ごとに残り方が違うのを消す)。
// - 中身は助言用の JSON 1 行 (読むのは worktree-lock-owner.mjs)。EX に到達した保持者だけが書く。
// - win32 は flock が無いので、何も開かず何も spawn しない unsupported オブジェクトを返す (§5)。
// verify.mjs の import graph に入るので、古い Node でもパースできる構文に保つ (verify.mjs 冒頭の bdboard-eu2k)。
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const LOCK_FILE_NAME = 'bdboard-worktree.lock';
export const FLOCK_HELPER_ENV = 'BDBOARD_FLOCK_HELPER';
export const OP = Object.freeze({ SH: 1, EX: 2, NB: 4, UN: 8 });

// ヘルパーの約束: fd 3 に flock(最後の引数の op) をかけ、0 = 取れた / 1 = 塞がっている (EWOULDBLOCK) / 他 = エラー。
const PERL_SCRIPT = 'open(F,"+<&=3") or exit 2; exit(flock(F,$ARGV[0]) ? 0 : (($!{EWOULDBLOCK}||$!{EAGAIN}) ? 1 : 2))';
// python の未捕捉例外は exit 1 (= 塞がっている) に見えてしまうので、OSError 以外も 2 に寄せる。
const PYTHON_SCRIPT = [
  'import sys',
  'try:',
  '    import errno, fcntl',
  '    fcntl.flock(3, int(sys.argv[1]))',
  'except OSError as e:',
  '    sys.exit(1 if e.errno in (errno.EWOULDBLOCK, errno.EAGAIN) else 2)',
  'except Exception:',
  '    sys.exit(2)',
].join('\n');
export const PERL_FLOCK_HELPER = Object.freeze(['perl', '-e', PERL_SCRIPT, '--']);
export const PYTHON_FLOCK_HELPER = Object.freeze(['python3', '-c', PYTHON_SCRIPT]);
const MAX_REOPEN = 3;
const HELPER_TIMEOUT_MS = 10_000; // 刺さったヘルパー (例: PERL5OPT=-d) で verify を黙って止めない。打ち切りは 'error'。
export function lockPathFor(gitDir) {
  return path.join(gitDir, LOCK_FILE_NAME);
}

/** ヘルパーで fd に flock(op) をかける。'ok' | 'busy' | 'error'。 */
export function runFlockHelper(helper, fd, op, spawnSync = nodeSpawnSync) {
  const options = { stdio: ['ignore', 'ignore', 'pipe', fd], windowsHide: true, timeout: HELPER_TIMEOUT_MS };
  const result = spawnSync(helper[0], helper.slice(1).concat(String(op)), options);
  // spawn の失敗・打ち切り (error)、シグナルでの終了 (status null) は 'error'。
  return result.error ? 'error' : result.status === 0 ? 'ok' : result.status === 1 ? 'busy' : 'error';
}

// BDBOARD_FLOCK_HELPER (JSON の argv 接頭辞、BDBOARD_MERGE_GH と同じ慣習) があればそれだけを試す (明示した上書きが
// 壊れているのを perl で黙って補わない)。無ければ perl → python3。
export function flockHelperCandidates(env = process.env) {
  const raw = env[FLOCK_HELPER_ENV];
  if (raw === undefined || raw === '') {
    return [PERL_FLOCK_HELPER, PYTHON_FLOCK_HELPER];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((part) => typeof part === 'string')) {
      return [parsed];
    }
  } catch {
    /* JSON でない値は「使えるヘルパーが無い」として扱う */
  }
  return [];
}

/** fd に LOCK_UN (何も持っていない記述では何もせず 0) をかけて動くヘルパーを探す。無ければ null。 */
export function findFlockHelper(fd, options = {}) {
  const spawnSync = options.spawnSync || nodeSpawnSync;
  for (const helper of flockHelperCandidates(options.env || process.env)) {
    if (runFlockHelper(helper, fd, OP.UN, spawnSync) === 'ok') {
      return helper;
    }
  }
  return null;
}

const openLockFile = (lockPath) => fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o644);

function unsupportedLock(lockPath, reason) {
  const refused = () => ({ ok: false, outcome: 'unsupported', held: null, converted: null });
  return {
    supported: false, reason, path: lockPath, helper: null, fd: null, mode: null,
    tryLock: refused, selfCheck: refused, writeOwner: () => false, release: () => {},
  };
}

// lock オブジェクトを作る (まだ lock しない。ファイルを開けなければ投げる)。1 プロセスに 1 つだけ作り、最後に release。
// tryLock('EX'|'SH') は常に非ブロッキングで投げず、{ ok, outcome: 'locked'|'busy'|'error'|'replaced'|'released',
// held: 今持っているモード, converted: 'EX->SH' などの変換 (変換でなければ null) } を返す。
export function openWorktreeLock(options) {
  const lockPath = options.path;
  const platform = options.platform || process.platform;
  const keepsSharedOnRefusedUpgrade = platform === 'darwin';
  if (platform === 'win32') {
    return unsupportedLock(lockPath, 'win32 has no flock (worktree lock is POSIX only)');
  }
  const spawnSync = options.spawnSync || nodeSpawnSync;
  let fd = openLockFile(lockPath);
  const helper = findFlockHelper(fd, { env: options.env, spawnSync });
  if (helper === null) {
    fs.closeSync(fd);
    return unsupportedLock(lockPath, `no flock helper (perl, python3 or ${FLOCK_HELPER_ENV})`);
  }
  let mode = null;
  const run = (op) => runFlockHelper(helper, fd, op, spawnSync);
  const sameFile = () => {
    try {
      const held = fs.fstatSync(fd);
      const onDisk = fs.statSync(lockPath);
      return held.dev === onDisk.dev && held.ino === onDisk.ino;
    } catch {
      return false;
    }
  };

  const lock = {
    supported: true, reason: null, path: lockPath, helper,
    get fd() { return fd; },
    get mode() { return mode; },
    tryLock(target) {
      if (fd === null) {
        return { ok: false, outcome: 'released', held: null, converted: null };
      }
      if (mode === target) {
        return { ok: true, outcome: 'locked', held: mode, converted: null };
      }
      const converted = mode === null ? null : `${mode}->${target}`;
      for (let attempt = 0; attempt < MAX_REOPEN; attempt += 1) {
        const outcome = run(OP[target] | OP.NB);
        if (outcome !== 'ok') {
          // bdboard-wea0.2 (#876 レビュー 4): XNU は拒否された SH→EX|NB の後も SH を残す (実測)。UN すると自分で隙間を
          // 作るので、SH|NB で持っていることを確かめ直して SH のままにする (残っていなければ取り直し、取れなければ下へ)。
          // Linux は変換の前に元の lock を外すので、何も持っていない状態に揃える (E4)。
          if (keepsSharedOnRefusedUpgrade && mode === 'SH' && target === 'EX' && outcome === 'busy' && run(OP.SH | OP.NB) === 'ok') {
            return { ok: false, outcome, held: 'SH', converted };
          }
          if (mode !== null) {
            run(OP.UN); // 変換の拒否: 元のモードが残るかは OS 次第なので、何も持っていない状態に揃える。
            mode = null;
          }
          return { ok: false, outcome, held: null, converted };
        }
        if (sameFile()) {
          mode = target;
          return { ok: true, outcome: 'locked', held: mode, converted };
        }
        // E5: path の先が別のファイルに替わっている。古い記述を閉じ (= その lock を手放し)、開き直して取り直す。
        // 閉じる・開き直すが失敗しても閉じた番号を持ち続けない (E11)。
        try {
          fs.closeSync(fd);
        } finally {
          fd = null;
          mode = null;
        }
        try {
          fd = openLockFile(lockPath);
        } catch {
          return { ok: false, outcome: 'error', held: null, converted };
        }
      }
      return { ok: false, outcome: 'replaced', held: null, converted };
    },
    /** lock (EX か SH) を持っている間、新しい 2 つ目の記述からの EX|NB が塞がることを確かめる (NFS 等の検出)。 */
    selfCheck() {
      if (fd === null || mode === null) {
        return { ok: false, outcome: fd === null ? 'released' : 'not-locked' };
      }
      const probeFd = openLockFile(lockPath);
      try {
        const outcome = runFlockHelper(helper, probeFd, OP.EX | OP.NB, spawnSync);
        return { ok: outcome === 'busy', outcome };
      } finally {
        fs.closeSync(probeFd);
      }
    },
    /** 助言用の持ち主を書く。EX を持っていなければ書かずに false。 */
    writeOwner(info) {
      if (fd === null || mode !== 'EX') {
        return false;
      }
      try {
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, `${JSON.stringify(info)}\n`, 0);
        return true;
      } catch {
        return false;
      }
    },
    /** fd を閉じる (fd を受け継いだ子がいれば lock はその子に残る)。以後の操作は拒否。何度呼んでもよい。 */
    release() {
      try {
        if (fd !== null) {
          fs.closeSync(fd);
        }
      } finally {
        fd = null; // close が投げても閉じた (かもしれない) 番号を持ち続けない (E11)
        mode = null;
      }
    },
  };
  return lock;
}
