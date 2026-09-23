import { SKILLS_DIR, skillInstallRelativePath } from '../harness-path.js';
import {
  CLAUDE_PROJECT_DIR_PLACEHOLDER,
  PACK_HOOKS_DIR,
  type HarnessHookPack,
  type PackHookDeclaration,
} from './types.js';

/**
 * 「この entry は我々のものか」を判定する識別子。
 *
 * 注入先の settings.json は人も他ツールも書くので、**この識別子に一致しない
 * entry は一切変更しない**。逆に一致する entry は宣言に合わせて置換し、宣言から
 * 消えたものは削除する (再注入の冪等性)。
 */
/**
 * 既知の限界: 注入先が `.claude/skills/<pack>/hooks/` を symlink で他所へ逃がして
 * いる場合、コマンド文字列は symlink のパスのままなので実体の位置は見ない。
 * 判定も登録もパス文字列だけで完結させる方針の帰結で、実害は「実体を差し替えられ
 * ても検知しない」— 注入先の `.claude/` を書ける人は settings.json 自体も書ける
 * ので、ここを厳しくしても得られる保証は増えない (PR#290 レビュー minor-2)。
 */
export function harnessHookMarker(packName: string): string {
  return `/${SKILLS_DIR}/${packName}/${PACK_HOOKS_DIR}/`;
}

/**
 * settings.json に書き込むコマンド文字列。パック名やスクリプトパスが安全でない
 * (パストラバーサル等) ときは null。
 *
 * スクリプト本体を直接呼ばず「あれば実行、無ければ黙って成功」で包む。自己注入
 * 以外の注入先では `.claude/skills/<pack>/` が `.gitignore` されるので、
 * settings.json だけがコミットされた repo を別の場所にクローンすると、hook 本体が
 * 無いまま毎ターン `exit 127` (No such file or directory) の stderr が出る。
 * `$CLAUDE_PROJECT_DIR` 自体が未設定のときも同じ経路で fail-open になる
 * (PR#290 レビュー major-2)。
 *
 * `$0` を使うのはパスを 1 度しか書かないため。`bash -c '<script>' <arg0>` の
 * `<arg0>` が `$0` になる。マーカー判定は部分一致なので、この包みでも我々の
 * entry だと識別できる。
 */
export function harnessHookCommand(
  packName: string,
  script: string,
  installRoot: string = CLAUDE_PROJECT_DIR_PLACEHOLDER,
): string | null {
  const relative = skillInstallRelativePath(packName, script);
  if (relative === null) {
    return null;
  }

  const command = `bash -c '[ -f "$0" ] || exit 0; exec bash "$0"' "${installRoot}/${relative}"`;
  // 識別子を含まないコマンドは後で我々のものだと判別できず、再注入で消せない。
  // そういう宣言 (hooks/ の外を指す script) は最初から書き込まない。
  return command.includes(harnessHookMarker(packName)) ? command : null;
}

export interface ResolvedHook {
  readonly declaration: PackHookDeclaration;
  readonly command: string;
}

// bdboard-sso1.66: 分割前は同一ファイル内の非公開関数/型だった。./merge.ts
// (mergeHarnessHooks) と ./evaluate.ts (evaluateHooksState) の両方が使うため export を
// 付けている。公開エクスポート面 (../harness-hooks.ts) には出さない。
export function resolveHooks(
  pack: HarnessHookPack,
  installRoot: string,
): readonly ResolvedHook[] {
  const resolved: ResolvedHook[] = [];
  for (const declaration of pack.hooks) {
    const command = harnessHookCommand(pack.name, declaration.script, installRoot);
    if (command === null) {
      continue;
    }
    resolved.push({ declaration, command });
  }
  return resolved;
}
