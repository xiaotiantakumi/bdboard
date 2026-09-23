// bdboard-sso1.81: agent-run-routes-test-support.ts のモジュール分割 (move only) で
// 切り出した、他のテスト支援モジュールから共有される純粋なリテラル定数置き場。
export const NOW = new Date('2026-06-01T12:00:00.000Z');
export const DEFAULT_REPO_ROOT = '/projects/bdboard';
export const LOCAL_HOST = 'localhost:8787';
export const LOCAL_ENV = {
  incoming: {
    socket: {
      remoteAddress: '127.0.0.1',
      localPort: 8787,
    },
  },
};
export const CF_HEADER = { 'CF-Ray': 'abc123-NRT' } as const;
export const SESSION_COOKIE = 'bdboard_tunnel_session=example-session-value';
