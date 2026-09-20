// bdboard-sso1.29: claude-runner.ts から move-only で分割。
// run 対象 worktree に絞った Read/Edit allow と .claude/** deny の組み立て。

/**
 * worktree パスを permission ルールに埋め込める形へ正規化する。
 * allow 側 (buildWorktreeScopedTools) と deny 側 (buildWorktreeScopedDenials) で
 * 同じ正規化を使わないと、deny だけがパスに一致せず無言で効かなくなる。
 */
export function assertRuleSafeWorktreePath(worktreePath: string): string {
  // 多層防御。provisioner 側で ticket id を allowlist 検証しているが、cwd は
  // RunRequest 経由で来るのでここでも壊れた形を弾く。fail-closed。
  if (/[)(*\n\r]/.test(worktreePath)) {
    throw new Error(
      `worktree path contains characters that break the permission rule: ${worktreePath}`,
    );
  }

  return worktreePath.startsWith('/') ? worktreePath : `/${worktreePath}`;
}

export function buildWorktreeScopedTools(worktreePath: string): readonly string[] {
  // Write(<path>) は CLI 自身が「file permission checks に使われない」と診断する。
  // Edit(<glob>) が Write を含む全ファイル編集ツールを覆う（claude CLI 2.1.233 実測）。
  //
  // 先頭のスラッシュ2つが load-bearing。claude CLI のパスルールは既定で
  // 「プロジェクト相対」と解釈されるため、`Edit(/abs/path/**)` と1つだけ書くと
  // 絶対パスが相対パス扱いになり **何にも一致しない**。実測 (2.1.233):
  //   Edit(/tmp/x/**)  → worktree 内の ./in.txt すら DENIED (ファイル未作成)
  //   Edit(//tmp/x/**) → 同じ操作が通る
  // fail-closed なので危険側には倒れないが、エージェントが一切ファイルを
  // 編集できず機能が無言で死ぬ。`--` 終端と同じく、単体テストでは
  // 「期待した文字列と一致するか」しか見えないので実プロセスでしか気づけない。
  const absolute = assertRuleSafeWorktreePath(worktreePath);
  return [`Read(/${absolute}/**)`, `Edit(/${absolute}/**)`];
}

/**
 * run 対象 worktree の `.claude/**` への書き込みを名指しで deny する (bdboard-f4kn)。
 *
 * 狙いは「エージェントが自分の worktree の `.claude/settings.json` を書き換えて
 * 権限天井を自分で上げる」経路を塞ぐこと。allowlist には `Edit(<worktree>/**)` が
 * 入っており、`.claude/` はその配下にあるので allow だけを見ると届いてしまう。
 *
 * ## なぜ「permissions.allow の追記」より深刻か (実測 2026-09-04, claude CLI 2.1.233)
 * このファイルの本当の危険は `permissions.allow` ではなく **hooks** である。
 * project 層の `.claude/settings.json` に置いた hooks は、permission 層を一切
 * 通らずにそのままシェルコマンドとして実行される:
 *   settings.json に SessionStart / PreToolUse hook (`touch <marker>`) を置いて run
 *     -> 両方の marker ファイルが生成され、permission_denials は空
 * つまり書き換えが成立した瞬間に allowlist の広さとは無関係な任意コード実行になる。
 * DENIED_TOOLS は permission 層の仕組みなので、この経路は原理的に止められない。
 *
 * ## 反映は「次回 run から」ではなく「その場で」(実測)
 * run の最中に外部から `.claude/settings.json` を差し替える実測を行った:
 *   1回目の `df -h /tmp` -> 実行された
 *   ここで settings.json を deny + hook 入りに差し替え
 *   2回目の `df -h /tmp` -> "Permission to use Bash ... has been denied." で拒否、
 *                           かつ差し替えで入れた PreToolUse hook の marker が生成
 * CLI は起動時スナップショットではなく都度読み直している。よって仮に書き込みが
 * 通れば昇格は同一セッション内で即座に効く。「次の run までは安全」ではない。
 *
 * ## 一次の防壁は CLI 側にあるが、それに依存しきらない
 * 実測では、現状この deny が無くても書き込みは CLI 自身に拒否される。CLI は
 * `.claude/` 配下を "sensitive file" として扱い、`Edit(<worktree>/**)` のような
 * 広い allow では許可されない:
 *   Write `.claude/notes.txt`        -> "which is a sensitive file."
 *   Write `.claude/settings.json`    -> "you haven't granted it yet"
 *   Bash `echo ... > .claude/settings.json` / `sed -i` も同じ書き込みチェックで拒否
 *   一方 `.hidden/x.txt` は書けたので、dot ディレクトリ一般ではなく `.claude/` 固有
 * ただしこれは CLI の内部仕様であって我々の契約ではない。将来のバージョンで
 * 緩んでも気づけないので、意図を自分の側で明示しておく。deny は allow に勝ち、
 * パススコープ付き deny が Write ツールと Bash のリダイレクトの両方を覆うことは
 * 実測済み (allow 配下の `open/` には書けるまま `secret/` だけが
 * "File is in a directory that is denied by your permission settings." で落ちた)。
 */
export function buildWorktreeScopedDenials(worktreePath: string): readonly string[] {
  const absolute = assertRuleSafeWorktreePath(worktreePath);
  return [`Edit(/${absolute}/.claude/**)`];
}
