// bdboard-2yp: npm run <script> を child_process.spawn するための引数を組み立てる。
//
// Windows では npm は npm.cmd (PATHEXT 経由) のため shell 無し spawn では ENOENT になる。
// さらに Node 20.12+ は CVE-2024-27980 (BatBadBut) 対策で .bat/.cmd を shell 無しで
// spawn すると EINVAL を投げるので、win32 では shell: true が必須。
// shell 経由なら cmd.exe が PATHEXT で解決するため command は拡張子なしの 'npm' でよく、
// そのほうが npm.cmd を持たない環境 (Volta の npm シム等) でも動く。
//
// POSIX では shell を挟まない — verify.mjs のプロセスグループ kill が shell 経由だと
// 孫プロセスが孤児化する (bdboard-kia) ため、win32 以外は従来どおり npm を直接 spawn する。
// 返す options を非 win32 で空オブジェクトに保つのは意図的で、呼び出し側の
// spawn 引数のキー集合を従来と厳密に同一にするため (npm-command.test.mjs で固定)。
//
// scriptName は win32 では cmd.exe のコマンドラインに素で連結される。呼び出し側は
// shell メタ文字 (& | < > ^ % 等) やスペースを含まない値のみを渡すこと。
export function npmRunSpawnSpec(scriptName, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const args = ['run', scriptName];

  if (platform === 'win32') {
    return {
      command: 'npm',
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
