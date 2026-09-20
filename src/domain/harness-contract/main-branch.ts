/**
 * `mainBranch` が git の argv に `origin/<name>` や `git fetch origin <name>` の
 * refspec として安全に埋め込めるか (bdboard-pkr6.18)。
 *
 * 値は注入先プロジェクトが書くファイル由来の信頼できない入力。`isSafeSingleLineValue`
 * は制御文字しか見ないので、`--upload-pack=...` のような値は git にオプションとして
 * 解釈されうる。git-check-ref-format の保守的な部分集合 — 素のブランチ名だけを通し、
 * 先頭 `-`・パス操作・リビジョン構文を拒む。worktree provisioner も同じ関数で
 * 二重に守る。
 */
export function isSafeMainBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9._/-]+$/.test(name)
    && !name.startsWith('-')
    && !name.startsWith('/')
    && !name.endsWith('/')
    && !name.includes('//')
    && !name.includes('..')
    && !name.endsWith('.')
    && name !== 'HEAD'
    && !name.split('/').some((segment) => segment.startsWith('.') || segment.endsWith('.lock'))
  );
}
