// bdboard-sso1.29: claude-runner.ts から move-only で分割。
// permissionMode / allowedTools / disallowedTools の既定値と解決ロジック。
import type { ClaudeRunnerOptions } from './options.js';

const VALID_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
] as const;

// run が使える能力の一次の天井 (allowlist 主体)。DEFAULT_SETTING_SOURCES が
// user 層を落とすので、このリストは実測上そのまま上限として機能する
// (bdboard-jgx5)。実測: --setting-sources project,local の下では、ここに無く
// ユーザーのグローバル allow にだけ載っている `docker --version` は拒否され、
// ここに在る `git status --short` は実行された。列挙外の verb (rsync/perl/tar
// など) も同じ理由で通らない。リストを広げることがそのまま権限の拡大になる。
//
// 封じ込め: Bash(git:*) は任意パス破壊・任意コマンド実行・公開 push へ化ける。
// Bash(npm:*) は npm exec 等で任意コード実行。Bash(bd:*) は bare dolt push で
// private issue 履歴漏洩。Write/Edit のベア指定はパス制約なし。
// 挙動がエージェント書き換え可能なファイル (package.json / scripts/) で決まる
// コマンドは allowlist に入れない。allowlist の内側を通って worktree 外へ
// 任意コード実行できる (実測)。依存インストールと検証は run の外 (人間/CI) で行う。
// エージェントにビルド/検証をやらせる設計は別チケット (M-4) で扱う。
export const DEFAULT_ALLOWED_TOOLS = [
  // Glob / Grep はベアのまま残す。パススコープ付きで動くかを実プロセスで確認できて
  // おらず、fail-closed で「エージェントが何も探せない」無言の機能死になるリスクが
  // あるため。無スコープの Glob/Grep が worktree 外の情報をログへ載せうる点は、
  // ログ取得の local-only 化 (M-1(b)) で外部への流出経路を塞いでいる。
  'Glob',
  'Grep',
  'Bash(bd show:*)',
  'Bash(bd list:*)',
  'Bash(bd comment:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
] as const;

/** Bash(...:*) ワイルドカードを許可する verb（DEFAULT_ALLOWED_TOOLS の構造テスト用）。 */
export const ALLOWED_BASH_WILDCARD_VERBS = [
  'bd show',
  'bd list',
  'bd comment',
  'git status',
  'git diff',
  'git add',
  'git commit',
] as const;

/**
 * 読み込む設定ソースを user 抜きに固定する (--setting-sources)。
 * これが「allowlist 主体」を成立させている唯一の仕掛け (bdboard-jgx5)。
 *
 * 実測 (claude CLI 2.1.233, 2026-09-04)。差分は本フラグの有無だけ、
 * `--allowedTools` は Glob/Grep/Bash(git status:*) のみ:
 *   フラグ無し                        -> `docker --version` が実行された
 *                                        (出力 "Docker version 29.5.2")、denials 空
 *   --setting-sources project,local   -> `docker --version` は
 *                                        "This command requires approval" で拒否、
 *                                        permission_denials に記録
 * `Bash(docker:*)` はユーザーのグローバル ~/.claude/settings.json の
 * permissions.allow にのみ載っている。つまり本フラグは B-1 の
 * 「--allowedTools がグローバル allow との和集合になり上限として機能しない」
 * を根元で断つ。CLAUDE_CONFIG_DIR 固定と違い認証は壊れない (実測: 同 run が
 * 正常完了。認証は $HOME/.claude.json と keychain 側にあり設定ソースではない)。
 *
 * `''` (全ソース除外) にはしない。実測で CLAUDE.md と worktree の
 * `.claude/skills/` (= inject 済み bdboard-harness パック) まで落ちるため:
 *   --setting-sources ''              -> CLAUDE.md のルール不適用、slash_commands 54、
 *                                        プロジェクト skill 不可視
 *   --setting-sources project,local   -> CLAUDE.md のルール適用、slash_commands 55、
 *                                        プロジェクト skill 可視
 * user 層だけを落とすのが目的なので project,local を残すのが正しい。
 */
export const DEFAULT_SETTING_SOURCES = 'project,local';

/**
 * allowlist を貫通されたときの第二の天井 (--disallowedTools)。
 *
 * DEFAULT_SETTING_SOURCES が入った今、一次の天井は allowlist
 * (DEFAULT_ALLOWED_TOOLS) 側にある。それでもこの名指し deny を残すのは、
 * 残った project/local 層が worktree の中にあるため。deny は allow に勝つ
 * (実測: グローバル allow に Bash(mv:*) があっても --disallowedTools の有無
 * だけで mv の実行有無が変わった)。M-2 の `.claude/settings.local.json` は
 * clearWorktreeLocalClaudeSettings() が起動直前に消し、project 層の
 * `.claude/**` への書き込みは buildWorktreeScopedDenials() が塞ぐ。
 * CLAUDE_CONFIG_DIR 固定は認証を壊すため撤回した (2026-09-04)。
 *
 * このリストは「permission 層で表現できる天井」でしかない点に注意
 * (bdboard-f4kn)。project 層 settings.json の hooks は permission 層を通らずに
 * 実行されるので、ここに何を足しても防げない。あの経路は
 * buildWorktreeScopedDenials() の deny で「書かせない」ことでしか止まらない。
 *
 * allowlist 外の verb がすべて落ちるわけでもない。CLI には無害な読み取り専用
 * コマンドの組み込み自動承認があり、実測 (2026-09-04) で `date` / `whoami` /
 * `df` は allowlist に無くても実行された (一方 `rsync` / `sw_vers` は
 * "This command requires approval" で拒否)。実効天井は
 * 「DEFAULT_ALLOWED_TOOLS ∪ CLI 組み込みの読み取り専用集合」であり、
 * 後者は我々が列挙も固定もできない。
 *
 * その組み込み集合に書き込み系・ネットワーク系が入っていないかを実測した
 * (bdboard-ky0j、2026-09-04、claude CLI 2.1.233)。判定できるのは DENIED_TOOLS に
 * 載っていない verb だけ (載っていれば deny が勝つので、拒否されても組み込み集合の
 * 話にならない)。該当する 6 件は全滅した:
 *
 *   書き込み系   touch / mkdir / echo リダイレクト -> 拒否
 *   ネットワーク ping / nc / git ls-remote         -> 拒否
 *
 * 対照群 (date/whoami/df が実行、rsync/sw_vers が拒否) も再現した。
 * よって 2.1.233 時点では、組み込み集合は無害な読み取り専用コマンドに留まる。
 *
 * 一次測定は cwd を /tmp 配下に置いており、macOS の /tmp は /private/tmp への
 * シンボリックリンクなので「許可ディレクトリとパスが食い違っただけ」の可能性が
 * 残っていた。**本番では run の cwd は worktree 自身なのでその食い違いは起きない**
 * =その読み筋なら本番では touch が通る、ということになる。そこでシンボリックリンクを
 * 含まない実パスで再測定した: 対象が許可ディレクトリの内側にあっても拒否され、かつ
 * permission_denials に記録が残った。つまり拒否しているのは permission 層である。
 * CLI のメッセージは "may only create or modify files in the allowed working
 * directories for this session: '<まさにそのディレクトリ>'" と出るので誤解を招く。
 * この文言を根拠に「別レイヤーが弾いている」と読まないこと。
 *
 * 追加の deny は入れない。実測で兆候が無く、足すべき対象をデータから導けないため
 * (根拠のない deny は天井を強くしたように見えて何も変えない)。代わりに残すのは
 * 再測定の手順である。**CLI を上げたらここを測り直すこと**:
 *
 *   1. 使い捨ての空ディレクトリを cwd にする (シンボリックリンクを含まない実パス)。
 *   2. DENIED_TOOLS はそのまま、--allowedTools だけを Glob 等へ絞って spawn する。
 *   3. DENIED_TOOLS に載っていない書き込み/ネットワーク verb を試す。
 *      上記 6 件が最低ライン (未測定: sftp / telnet / dd / tee / install など)。
 *   4. 対照群も併せて流し、測定条件そのものが壊れていないことを確かめる。
 *
 * 上の分類は 2.1.233 での観測であって契約ではない。DEFAULT_ALLOWED_TOOLS を
 * 読んだだけでは「この run に何ができるか」は答えられない。
 *
 * ベアな `Bash` は入れない。実測 (2026-09-04): `--disallowedTools Bash` は
 * 権限拒否ではなく **Bash ツールごとモデルの tool set から消える**
 * (「I don't have a Bash tool available」と返し tool_use が一件も出ない)。
 * 明示した `--allowedTools Bash(git status:*)` も道連れになるため、
 * 「ベア deny + 粒度 allow」という構成は CLI の意味論として成立しない。
 */
export const DENIED_TOOLS = [
  'WebFetch',
  'WebSearch',
  'Task',
  'Bash(sudo:*)',
  'Bash(npm:*)',
  'Bash(npx:*)',
  'Bash(pnpm:*)',
  'Bash(yarn:*)',
  'Bash(git push:*)',
  'Bash(bd dolt:*)',
  'Bash(mv:*)',
  'Bash(cp:*)',
  'Bash(rm:*)',
  'Bash(ln:*)',
  'Bash(chmod:*)',
  'Bash(chown:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
  'Bash(ssh:*)',
  'Bash(scp:*)',
  'Bash(docker:*)',
  'Bash(find:*)',
  'Bash(bash:*)',
  'Bash(sh:*)',
  'Bash(zsh:*)',
  'Bash(node:*)',
  'Bash(python:*)',
  'Bash(python3:*)',
  'Bash(eval:*)',
  'Bash(env:*)',
  'Bash(open:*)',
] as const;

export function resolvePermissionMode(options?: ClaudeRunnerOptions): string {
  let mode: string | undefined;

  if (options?.permissionMode !== undefined && options.permissionMode !== '') {
    mode = options.permissionMode;
  } else {
    const fromEnv = process.env.BDBOARD_RUN_PERMISSION_MODE;
    if (fromEnv !== undefined && fromEnv.trim() !== '') {
      mode = fromEnv.trim();
    }
  }

  if (mode === undefined) {
    // acceptEdits だと Edit(<worktree>/**) のパススコープが無視される（claude CLI
    // 2.1.233 実測）。M-1 の封じ込めそのものが無効化されるため default を使う。
    // default でも `-p`（非対話）のまま許可内の操作は確認を求めず進む（実測）。
    // bypassPermissions は明示設定時のみ。
    return 'default';
  }

  if (!(VALID_PERMISSION_MODES as readonly string[]).includes(mode)) {
    console.warn(
      `unknown BDBOARD_RUN_PERMISSION_MODE "${mode}", falling back to default`,
    );
    return 'default';
  }

  return mode;
}

export function resolveAllowedTools(
  options?: ClaudeRunnerOptions,
): readonly string[] | undefined {
  if (options?.allowedTools !== undefined) {
    return options.allowedTools.length > 0 ? options.allowedTools : undefined;
  }

  const fromEnv = process.env.BDBOARD_RUN_ALLOWED_TOOLS;
  if (fromEnv !== undefined) {
    // Empty string explicitly opts out of --allowedTools (ambient Claude config).
    if (fromEnv === '') {
      return undefined;
    }

    // BDBOARD_RUN_ALLOWED_TOOLS は JSON 文字列配列（例:
    // '["Read","Bash(git status:*)"]'）。カンマ分割だと Bash(git diff:*) 等が壊れる。
    try {
      const parsed: unknown = JSON.parse(fromEnv);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((entry) => typeof entry === 'string' && entry !== '')
      ) {
        return parsed;
      }
      console.warn(
        'BDBOARD_RUN_ALLOWED_TOOLS must be a JSON array of non-empty strings; falling back to defaults',
      );
    } catch {
      console.warn(
        'BDBOARD_RUN_ALLOWED_TOOLS is not valid JSON; falling back to defaults',
      );
    }
    return DEFAULT_ALLOWED_TOOLS;
  }

  return DEFAULT_ALLOWED_TOOLS;
}
