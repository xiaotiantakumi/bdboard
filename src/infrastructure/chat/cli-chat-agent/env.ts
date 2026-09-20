export function buildAllowedEnv(
  source: NodeJS.ProcessEnv,
  allowlist: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
