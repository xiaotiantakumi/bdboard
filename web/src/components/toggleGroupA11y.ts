/**
 * ARIA helpers for exclusive toggle groups (.toggle-btn + .active).
 *
 * Policy:
 * - **aria-current**: primary view / location navigation where the control switches
 *   the main page region (GlobalBar view switcher). Matches ChatPanel thread
 *   selection. Active item gets aria-current="true"; inactive items omit the
 *   attribute (do not set "false").
 * - **aria-pressed**: parameter and filter toggles in exclusive groups (display
 *   limit, stats weeks, activity/digest window, board filters, presets). Always
 *   set true or false so assistive tech can read the group state.
 *
 * Intentionally omit aria-pressed where the visible label already conveys binary
 * state without a grouped context (ChatPanel layout controls — PR#139).
 */
export function navCurrentProps(
  isCurrent: boolean,
): { 'aria-current'?: 'true' } {
  return isCurrent ? { 'aria-current': 'true' } : {};
}

export function togglePressedProps(
  isPressed: boolean,
): { 'aria-pressed': boolean } {
  return { 'aria-pressed': isPressed };
}
