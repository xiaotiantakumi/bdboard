import { SKILLS_DIR, skillInstallRelativePath } from './harness-path.js';

/**
 * 注入したパックの hooks を注入先の `.claude/settings.json` へ登録する純粋関数群
 * (bdboard-pkr6.2)。
 *
 * スクリプトをコピーしただけでは Claude Code は hook を実行しない。settings.json
 * に登録して初めて効くので、注入時に自動でマージする。「手順として案内する」に
 * とどめないのは、文章ルールと同じ弱さ (読まれなければ効かない) を持つため。
 *
 * ここが純粋関数なのは、**既存の settings.json を壊さない**ことをテストで固定
 * したいから。ファイル I/O は infrastructure 側に置く。
 */

/** 注入先プロジェクトの Claude Code 設定ファイル。 */
export const SETTINGS_RELATIVE_PATH = '.claude/settings.json';

/**
 * hook のコマンドに書き込むプロジェクトルート。Claude Code が hook 実行時に
 * 設定する環境変数で、絶対パスを書き込まない (worktree や別マシンで壊れる)。
 */
export const CLAUDE_PROJECT_DIR_PLACEHOLDER = '$CLAUDE_PROJECT_DIR';

/** pack.json の hook 宣言で `timeout` を省略したときの秒数。 */
export const DEFAULT_PACK_HOOK_TIMEOUT_SECONDS = 10;

/** パック内で hook スクリプトを置くディレクトリ (pack 根からの相対、POSIX)。 */
export const PACK_HOOKS_DIR = 'hooks';

/**
 * pack.json が宣言する hook 1件。
 *
 * `matcher` が空文字のときは settings.json 側に `matcher` キーを書かない
 * (Claude Code は Stop のような matcher を持たないイベントでこれを無視するので、
 * 書いても意味が無く差分だけが増える)。
 *
 * `timeout` は秒。settings.json には**常に**明示的な値を書く — Claude Code の
 * 既定 (600 秒) のままだと、bd を複数回叩く Stop hook が Dolt のロック競合時に
 * 毎ターン最大 10 分固まりうる (bdboard-pkr6.1 レビュー M3)。
 */
export interface PackHookDeclaration {
  readonly event: string;
  readonly matcher: string;
  readonly script: string;
  readonly timeout: number;
}

/** `mergeHarnessHooks` / `evaluateHooksState` が必要とする最小のパック情報。 */
export interface HarnessHookPack {
  readonly name: string;
  readonly hooks: readonly PackHookDeclaration[];
}

export type HarnessHooksState = 'ok' | 'missing' | 'partial' | 'none-declared';

export interface HarnessHooksEvaluation {
  readonly state: HarnessHooksState;
  /** 未登録の hook のコマンド文字列 (`ok` / `none-declared` では空)。 */
  readonly missingHooks: readonly string[];
}

export type MergeHarnessHooksResult =
  | {
      readonly ok: true;
      readonly settingsJson: string;
      readonly registered: readonly string[];
    }
  | { readonly ok: false; readonly settingsJson: null; readonly error: string };

type JsonObject = Record<string, unknown>;

const HOOKS_KEY = 'hooks';
const COMMAND_HOOK_TYPE = 'command';

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

interface ResolvedHook {
  readonly declaration: PackHookDeclaration;
  readonly command: string;
}

function resolveHooks(pack: HarnessHookPack, installRoot: string): readonly ResolvedHook[] {
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

function isOwnHookEntry(entry: unknown, marker: string): boolean {
  return (
    isPlainObject(entry) &&
    typeof entry.command === 'string' &&
    entry.command.includes(marker)
  );
}

function failure(error: string): MergeHarnessHooksResult {
  return { ok: false, settingsJson: null, error };
}

/**
 * 既存の settings.json 本文 (無ければ null) に、パックの hook 宣言をマージする。
 *
 * - 我々の entry は全 event から一度取り除いてから宣言順に足し直す (冪等)。
 * - 同じ matcher の既存 group があっても**別 group として追加**する。他人の
 *   group の hooks 配列に混ぜると、削除時に境界が曖昧になるため。
 * - 既存キーの順序は保つ (`JSON.parse` → 破壊的編集 → `JSON.stringify`)。
 */
export function mergeHarnessHooks(
  existingSettingsJson: string | null,
  pack: HarnessHookPack,
  installRoot: string = CLAUDE_PROJECT_DIR_PLACEHOLDER,
): MergeHarnessHooksResult {
  let root: JsonObject;
  if (existingSettingsJson === null || existingSettingsJson.trim().length === 0) {
    root = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingSettingsJson);
    } catch {
      return failure(`${SETTINGS_RELATIVE_PATH} を JSON として解釈できません`);
    }
    if (!isPlainObject(parsed)) {
      return failure(`${SETTINGS_RELATIVE_PATH} のトップレベルがオブジェクトではありません`);
    }
    root = parsed;
  }

  const existingHooks = root[HOOKS_KEY];
  let hooksObject: JsonObject;
  if (existingHooks === undefined) {
    hooksObject = {};
  } else if (isPlainObject(existingHooks)) {
    hooksObject = existingHooks;
  } else {
    return failure(`${SETTINGS_RELATIVE_PATH} の hooks がオブジェクトではありません`);
  }

  const marker = harnessHookMarker(pack.name);
  const emptiedEvents = new Set<string>();

  // 1) 既存の「我々の entry」を全 event から取り除く。空になった event はキーの
  //    位置を保つために空配列を残し、最後に消す (再注入で並びが揺れないように)。
  for (const eventName of Object.keys(hooksObject)) {
    const groups = hooksObject[eventName];
    if (!Array.isArray(groups)) {
      continue;
    }

    let removed = false;
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group[HOOKS_KEY])) {
        kept.push(group);
        continue;
      }

      const entries = group[HOOKS_KEY] as readonly unknown[];
      const keptEntries = entries.filter((entry) => !isOwnHookEntry(entry, marker));
      if (keptEntries.length === entries.length) {
        kept.push(group);
        continue;
      }

      removed = true;
      if (keptEntries.length === 0) {
        // 我々だけの group だったので group ごと消す。
        continue;
      }
      kept.push({ ...group, [HOOKS_KEY]: keptEntries });
    }

    if (!removed) {
      continue;
    }
    hooksObject[eventName] = kept;
    if (kept.length === 0) {
      emptiedEvents.add(eventName);
    }
  }

  // 2) 宣言を宣言順に足す。
  const registered: string[] = [];
  for (const { declaration, command } of resolveHooks(pack, installRoot)) {
    const entry: JsonObject = {
      type: COMMAND_HOOK_TYPE,
      command,
      timeout: declaration.timeout,
    };
    const group: JsonObject =
      declaration.matcher.length > 0
        ? { matcher: declaration.matcher, [HOOKS_KEY]: [entry] }
        : { [HOOKS_KEY]: [entry] };

    // 既存配列の**末尾**に足す。再注入すると我々の group が他人の group より後ろへ
    // 回りうるが、これは意図的 — 前に割り込むと他人の hook の実行順を我々の都合で
    // 変えることになる。同一 event 内の順序は Claude Code にとって実行順であり、
    // 他人のものを動かさないほうを優先する。
    const current = hooksObject[declaration.event];
    if (current === undefined) {
      hooksObject[declaration.event] = [group];
    } else if (Array.isArray(current)) {
      current.push(group);
      emptiedEvents.delete(declaration.event);
    } else {
      return failure(
        `${SETTINGS_RELATIVE_PATH} の hooks.${declaration.event} が配列ではありません`,
      );
    }
    registered.push(command);
  }

  // 3) 我々が空にしただけの event キーを落とす。元から空だったものは触らない。
  for (const eventName of emptiedEvents) {
    delete hooksObject[eventName];
  }

  if (root[HOOKS_KEY] === undefined && Object.keys(hooksObject).length > 0) {
    root[HOOKS_KEY] = hooksObject;
  }

  return {
    ok: true,
    settingsJson: `${JSON.stringify(root, null, 2)}\n`,
    registered,
  };
}

/**
 * settings.json の本文 (無ければ null) から hook 登録状況を判定する。
 *
 * 判定は「宣言された event の下に、まったく同じコマンド文字列の entry があるか」。
 * matcher と timeout は見ない — event は hook が走るかどうかを決める構造だが、
 * matcher は絞り込み、timeout は実行時パラメータで、どちらもズレていれば
 * 再注入で直る一方、ここで厳しく見ると人が手で書いた等価な登録まで警告になる。
 * パック版の更新は drift 側が拾う。
 */
export function evaluateHooksState(
  settingsJson: string | null,
  pack: HarnessHookPack,
  installRoot: string = CLAUDE_PROJECT_DIR_PLACEHOLDER,
): HarnessHooksEvaluation {
  const resolved = resolveHooks(pack, installRoot);
  if (resolved.length === 0) {
    return { state: 'none-declared', missingHooks: [] };
  }

  const registeredByEvent = readRegisteredCommands(settingsJson);
  const missingHooks = resolved
    .filter(({ declaration, command }) => {
      const commands = registeredByEvent.get(declaration.event);
      return commands === undefined || !commands.has(command);
    })
    .map(({ command }) => command);

  if (missingHooks.length === 0) {
    return { state: 'ok', missingHooks: [] };
  }
  if (missingHooks.length === resolved.length) {
    return { state: 'missing', missingHooks };
  }
  return { state: 'partial', missingHooks };
}

/** event 名 → 登録済みコマンド文字列。読めない settings.json は空 (= すべて未登録)。 */
function readRegisteredCommands(settingsJson: string | null): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  if (settingsJson === null) {
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson);
  } catch {
    return result;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed[HOOKS_KEY])) {
    return result;
  }

  const hooksObject = parsed[HOOKS_KEY];
  for (const [eventName, groups] of Object.entries(hooksObject)) {
    if (!Array.isArray(groups)) {
      continue;
    }

    const commands = new Set<string>();
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group[HOOKS_KEY])) {
        continue;
      }
      for (const entry of group[HOOKS_KEY] as readonly unknown[]) {
        if (
          isPlainObject(entry) &&
          entry.type === COMMAND_HOOK_TYPE &&
          typeof entry.command === 'string'
        ) {
          commands.add(entry.command);
        }
      }
    }
    result.set(eventName, commands);
  }

  return result;
}
