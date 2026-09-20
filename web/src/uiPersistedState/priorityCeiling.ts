// bdboard-sso1.26: web/src/uiPersistedState.ts から move-only で分割。
// 挙動・型は変えていない (移動のみ)。

export type PriorityCeilingChoice = 'all' | '0' | '1' | '2' | '3' | '4';

export function validatePriorityCeiling(value: unknown): PriorityCeilingChoice | null {
  if (
    value === 'all' ||
    value === '0' ||
    value === '1' ||
    value === '2' ||
    value === '3' ||
    value === '4'
  ) {
    return value;
  }
  return null;
}

export function priorityCeilingValue(choice: PriorityCeilingChoice): number | null {
  if (choice === 'all') {
    return null;
  }
  return Number(choice);
}
