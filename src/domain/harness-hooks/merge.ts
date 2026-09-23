import {
  CLAUDE_PROJECT_DIR_PLACEHOLDER,
  SETTINGS_RELATIVE_PATH,
  type HarnessHookPack,
  type JsonObject,
  type MergeHarnessHooksResult,
} from './types.js';
import { COMMAND_HOOK_TYPE, HOOKS_KEY, isPlainObject } from './shared.js';
import { harnessHookMarker, resolveHooks } from './command.js';

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
