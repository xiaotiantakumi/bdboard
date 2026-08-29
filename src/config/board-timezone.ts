export function getBoardTimeZoneOverride(): string | undefined {
  const override = process.env.BDBOARD_TIMEZONE?.trim();
  if (override === undefined || override === '') {
    return undefined;
  }
  return override;
}

export function getBoardTimeZone(): string {
  const override = getBoardTimeZoneOverride();
  if (override !== undefined) {
    return override;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
