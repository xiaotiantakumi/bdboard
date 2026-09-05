export interface HealthBody {
  readonly ok?: boolean;
  readonly instanceNonce?: string;
}

export type FetchHealthResult =
  | { readonly kind: 'ok'; readonly body: HealthBody }
  | { readonly kind: 'http_error'; readonly status: number }
  | { readonly kind: 'invalid_body'; readonly error: unknown }
  | { readonly kind: 'network_error'; readonly error: unknown };

export interface WaitForHealthParams {
  readonly url: string;
  readonly port: number;
  readonly expectedNonce: string;
  readonly isChildAlive: () => boolean;
  /** 子が死んでいるときのエラー。未指定時は汎用メッセージ。 */
  readonly onChildNotAlive?: () => Error;
  readonly fetchHealth: (url: string) => Promise<FetchHealthResult>;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 200;

export class WrongHealthServerError extends Error {
  readonly reason: 'nonce_mismatch' | 'invalid_body';

  constructor(
    readonly port: number,
    readonly expectedNonce: string,
    readonly actualNonce: string | undefined,
    options?: { readonly reason?: 'invalid_body' },
  ) {
    const reason = options?.reason ?? 'nonce_mismatch';
    if (reason === 'invalid_body') {
      super(
        `bdboard e2e: the server answering on port ${port} did not identify itself as this run's instance — ` +
          `it did not return bdboard health JSON (expected instanceNonce=${expectedNonce}). ` +
          'The spawned e2e server may have failed to bind, or another process or proxy may be holding the port.',
      );
    } else {
      const actualLabel =
        actualNonce === undefined ? '(missing instanceNonce field)' : actualNonce;
      super(
        `bdboard e2e: the server answering on port ${port} did not identify itself as this run's instance ` +
          `(expected instanceNonce=${expectedNonce}, got ${actualLabel}). ` +
          'The spawned e2e server may have failed to bind, and another process may be holding the port.',
      );
    }
    this.name = 'WrongHealthServerError';
    this.reason = reason;
  }
}

function assertMatchingNonce(
  port: number,
  expectedNonce: string,
  body: unknown,
): void {
  if (typeof body !== 'object' || body === null) {
    throw new WrongHealthServerError(port, expectedNonce, undefined, {
      reason: 'invalid_body',
    });
  }
  const healthBody = body as HealthBody;
  if (healthBody.ok !== true) {
    throw new WrongHealthServerError(port, expectedNonce, undefined, {
      reason: 'invalid_body',
    });
  }
  const actual = healthBody.instanceNonce;
  if (actual !== expectedNonce) {
    throw new WrongHealthServerError(port, expectedNonce, actual);
  }
}

/**
 * Polls /api/health until the spawned child responds with the expected instance nonce.
 * Nonce mismatch and non-health 200 responses fail immediately (no retry).
 * Connection refusal (network_error) and non-2xx (http_error) retry until the deadline;
 * timeout messages distinguish the two cases.
 */
export async function waitForHealth(params: WaitForHealthParams): Promise<void> {
  const {
    url,
    port,
    expectedNonce,
    isChildAlive,
    onChildNotAlive,
    fetchHealth,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = params;

  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let sawHttpResponse = false;
  let lastHttpStatus: number | undefined;

  while (Date.now() < deadline) {
    if (!isChildAlive()) {
      throw (
        onChildNotAlive?.() ??
        new Error(
          'bdboard e2e server exited before becoming healthy (child process is no longer alive)',
        )
      );
    }

    try {
      const result = await fetchHealth(url);
      if (result.kind === 'network_error') {
        lastError = result.error;
      } else if (result.kind === 'invalid_body') {
        // 200 なのに health JSON に読めない = 他人のサーバー。即 fail（リトライしても改善しない）。
        throw new WrongHealthServerError(port, expectedNonce, undefined, {
          reason: 'invalid_body',
        });
      } else if (result.kind === 'http_error') {
        // 非 2xx を即 fail にすると、将来 readiness ゲートが一時的に 5xx を返す設計にしたときに自傷する。
        // よってリトライは残し、代わりに最終タイムアウトのメッセージで「HTTP は返ってきたが名乗らなかった」
        // ことを伝えて診断可能にする。
        sawHttpResponse = true;
        lastHttpStatus = result.status;
        lastError = new Error(`unexpected status ${result.status}`);
      } else {
        assertMatchingNonce(port, expectedNonce, result.body);
        return;
      }
    } catch (err) {
      if (err instanceof WrongHealthServerError) {
        throw err;
      }
      lastError = err;
    }

    await sleep(pollIntervalMs);
  }

  if (sawHttpResponse) {
    throw new Error(
      `bdboard e2e server did not become healthy within ${timeoutMs}ms; a server on port ${port} answered HTTP (last: status ${lastHttpStatus}) but never identified itself as this run's instance (instanceNonce=${expectedNonce}) — another process may be holding the port.`,
    );
  }

  throw new Error(
    `bdboard e2e server did not become healthy within ${timeoutMs}ms: ${String(lastError)}`,
  );
}

/** global-setup 向け: fetch を Health ポーリング形状へ変換する */
export async function fetchHealthViaFetch(url: string): Promise<FetchHealthResult> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { kind: 'http_error', status: res.status };
    }
    try {
      const body = (await res.json()) as HealthBody;
      return { kind: 'ok', body };
    } catch (error) {
      return { kind: 'invalid_body', error };
    }
  } catch (error) {
    return { kind: 'network_error', error };
  }
}
