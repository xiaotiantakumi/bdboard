import type { AuthMode } from './types.js';

/** 環境変数から認証モードを決める。純粋関数(process.env を直接読まず引数で受ける) */
export function resolveAuthMode(
  env: Readonly<Record<string, string | undefined>>,
): AuthMode {
  const user = env.BDBOARD_AUTH_USER;
  const password = env.BDBOARD_AUTH_PASSWORD;

  if (user !== undefined && user !== '' && password !== undefined && password !== '') {
    return { kind: 'enabled', config: { username: user, password } };
  }

  const disabled = env.BDBOARD_AUTH_DISABLED;
  if (disabled === '1' || disabled === 'true') {
    return { kind: 'disabled-explicitly' };
  }

  return { kind: 'unconfigured' };
}
