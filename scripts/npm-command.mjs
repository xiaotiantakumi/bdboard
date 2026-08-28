// bdboard-2yp: npm run <script> を child_process.spawn するための引数を組み立てる。
//
// Windows では npm は npm.cmd (PATHEXT 経由) のため shell 無し spawn では ENOENT になる。
// POSIX では shell を挟まない — verify.mjs のプロセスグループ kill が shell 経由だと
// 孫プロセスが孤児化する (bdboard-kia) ため、win32 以外は従来どおり npm を直接 spawn する。
export function npmRunSpawnSpec(scriptName, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const args = ['run', scriptName];

  if (platform === 'win32') {
    return {
      command: 'npm.cmd',
      args,
      options: { shell: true },
    };
  }

  return {
    command: 'npm',
    args,
    options: {},
  };
}
