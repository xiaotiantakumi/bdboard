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
 *
 * `settingsJson` は 1 本でも配列でもよい。配列のときは**和集合**で判定する
 * (bdboard-l1m1.8: 通常の注入先は settings.local.json、自己注入と移行前の注入先は
 * settings.json に登録されているため、どちらか一方だけ見ると全プロジェクトが
 * 「未登録」に見える)。
 */
export function evaluateHooksState(
  settingsJson: string | null | readonly (string | null)[],
  pack: HarnessHookPack,
  installRoot: string = CLAUDE_PROJECT_DIR_PLACEHOLDER,
): HarnessHooksEvaluation {
  const resolved = resolveHooks(pack, installRoot);
  if (resolved.length === 0) {
    return { state: 'none-declared', missingHooks: [] };
  }

  const registeredByEvent = mergeRegisteredCommands(
    (typeof settingsJson === 'string' || settingsJson === null ? [settingsJson] : settingsJson).map(
      readRegisteredCommands,
    ),
  );
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

function mergeRegisteredCommands(
  sources: readonly Map<string, Set<string>>[],
): Map<string, Set<string>> {
  const merged = new Map<string, Set<string>>();
  for (const source of sources) {
    for (const [eventName, commands] of source) {
      const existing = merged.get(eventName);
      if (existing === undefined) {
        merged.set(eventName, new Set(commands));
        continue;
      }
      for (const command of commands) {
        existing.add(command);
      }
    }
  }
  return merged;
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
