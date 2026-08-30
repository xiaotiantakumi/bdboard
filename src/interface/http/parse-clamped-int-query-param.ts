export interface ClampedIntQueryParamOptions {
  min: number;
  max: number;
  defaultValue: number;
}

export function parseClampedIntQueryParam(
  raw: string | undefined,
  { min, max, defaultValue }: ClampedIntQueryParamOptions,
): number {
  if (raw === undefined || raw === '') {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  return Math.min(max, Math.max(min, parsed));
}
