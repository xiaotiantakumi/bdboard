import {
  CLAUDE_PROJECT_DIR_PLACEHOLDER,
  type HarnessHookPack,
  type HarnessHooksEvaluation,
} from './types.js';
import { COMMAND_HOOK_TYPE, HOOKS_KEY, isPlainObject } from './shared.js';
import { resolveHooks } from './command.js';

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
