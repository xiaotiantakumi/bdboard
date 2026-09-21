export const AGENT_COMMAND_BASENAMES = new Set([
  'claude',
  'claude.exe',
  'cursor-agent',
  'codex',
  'agy',
  'gemini',
]);

export function tokenBasename(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return '';
  }

  const lastSlash = Math.max(
    trimmed.lastIndexOf('/'),
    trimmed.lastIndexOf('\\'),
  );
  return lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
}

export function matchesAgentCommand(commandLine: string): string | undefined {
  if (commandLine.includes('/Applications/')) {
    return undefined;
  }

  for (const token of commandLine.split(/\s+/)) {
    const basename = tokenBasename(token);
    if (basename.length === 0 || basename === 'node') {
      continue;
    }

    if (AGENT_COMMAND_BASENAMES.has(basename)) {
      return basename;
    }
  }

  return undefined;
}
