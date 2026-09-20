// bdboard-sso1.29: claude-runner.ts から move-only で分割。
import fs from 'node:fs';
import path from 'node:path';

/**
 * run 対象 worktree の .claude/settings.local.json を dispatch 前に削除する。
 * このファイルはグローバル gitignore で ignored なので git status --porcelain の
 * clean 判定に映らない。前の run がここへ権限やフックを仕込み、worktree は clean の
 * まま次の run が昇格した権限で始まる経路が成立していた (bdboard-54be.1 M-2)。
 * これが M-2 (worktree ローカル設定の持ち越し) の唯一のカバー。存在しなければ何もしない。
 *
 * 兄弟の `.claude/settings.json` (project 層) は **意図的に消さない**
 * (bdboard-f4kn)。このリポジトリでは git 追跡下にあり、`bd prime` を回す
 * SessionStart hook という正当な中身を持っているので、消せば毎 run ごとに
 * 偽の差分が出たうえで意図した挙動まで失われる。あちらは「消す」ではなく
 * 「書かせない」で守る — buildWorktreeScopedDenials() を参照。
 */
export function clearWorktreeLocalClaudeSettings(worktreePath: string): void {
  try {
    const target = path.join(worktreePath, '.claude', 'settings.local.json');
    if (!fs.existsSync(target)) {
      return;
    }
    fs.rmSync(target, { force: true });
    console.warn(
      `removed worktree-local claude settings before run: ${target}`,
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `failed to remove worktree-local claude settings in ${worktreePath}: ${detail}`,
    );
  }
}
