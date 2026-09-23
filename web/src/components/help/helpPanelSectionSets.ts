// bdboard-sso1.67: useHelpPanelFilter.ts から、開閉セクション ID の
// Set (openSectionIds/closedWhileFilteringIds) を更新する副作用なしのヘルパーを
// move-only で切り出したモジュール。各関数の本体は、分割前に
// handleSectionToggle/handleToggleAll/handleJumpToSection の setState 更新関数
// 内に書かれていた分岐のうちの1つをそのまま関数化したもので、ロジックは変えて
// いない(分割前後の等価性は helpPanelSectionSets.test.ts で固定)。
import type { HelpSection } from '../../helpContent';

/**
 * sectionId が previous に無ければ追加した新しい Set を返す。既に含まれていれば
 * previous をそのまま返す(参照同一性を保つ)。分割前の handleSectionToggle /
 * handleJumpToSection の「開く」分岐と同じロジック。
 */
export function openSection(
  previous: ReadonlySet<string>,
  sectionId: string,
): ReadonlySet<string> {
  if (previous.has(sectionId)) {
    return previous;
  }
  const next = new Set(previous);
  next.add(sectionId);
  return next;
}

/**
 * sectionId が previous に含まれていれば取り除いた新しい Set を返す。含まれて
 * いなければ previous をそのまま返す(参照同一性を保つ)。分割前の
 * handleSectionToggle / handleJumpToSection の「閉じる」分岐と同じロジック。
 */
export function closeSection(
  previous: ReadonlySet<string>,
  sectionId: string,
): ReadonlySet<string> {
  if (!previous.has(sectionId)) {
    return previous;
  }
  const next = new Set(previous);
  next.delete(sectionId);
  return next;
}

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const id of a) {
    if (!b.has(id)) {
      return false;
    }
  }
  return true;
}

/**
 * sections の id を全て previous に追加した Set を返す。結果が previous と
 * 同じ内容になる場合は previous をそのまま返す(参照同一性を保つ)。分割前の
 * handleToggleAll の「全部追加」分岐 + 直後の不変チェックと同じロジック。
 */
export function addAllToSet(
  previous: ReadonlySet<string>,
  sections: readonly HelpSection[],
): ReadonlySet<string> {
  const next = new Set(previous);
  for (const section of sections) {
    next.add(section.id);
  }
  return sameMembers(next, previous) ? previous : next;
}

/**
 * sections の id を全て previous から取り除いた Set を返す。結果が previous と
 * 同じ内容になる場合は previous をそのまま返す(参照同一性を保つ)。分割前の
 * handleToggleAll の「全部削除」分岐 + 直後の不変チェックと同じロジック。
 */
export function removeAllFromSet(
  previous: ReadonlySet<string>,
  sections: readonly HelpSection[],
): ReadonlySet<string> {
  const next = new Set(previous);
  for (const section of sections) {
    next.delete(section.id);
  }
  return sameMembers(next, previous) ? previous : next;
}
