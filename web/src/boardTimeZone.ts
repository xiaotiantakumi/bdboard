let serverOverride: string | undefined;

export function setBoardTimeZoneOverride(timeZone: string | null | undefined): void {
  serverOverride = timeZone ?? undefined;
}

export function getBoardTimeZone(): string {
  if (serverOverride !== undefined) {
    return serverOverride;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function resetBoardTimeZoneForTests(): void {
  serverOverride = undefined;
}
