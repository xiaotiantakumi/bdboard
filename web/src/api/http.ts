export class ApiError extends Error {
  readonly status: number;
  readonly body?: string;
  readonly errorMessage?: string;
  readonly detail?: string;
  /** スキャンルート拒否などの追加情報。サーバーのレスポンスをそのまま保持する(bdboard-mmb)。 */
  readonly details?: unknown;
  /**
   * chat エージェント失敗コード(例: 'agent-workspace-untrusted')。サーバーの
   * agent-error レスポンス(502)は `{ error, code, detail }` を返す(chat-routes.ts)。
   * `code` はここまで運ばれず ChatPanel が定型文にマップできなかった
   * (bdboard-l1t.5 Opus 再レビュー DF1)。他のエンドポイントは code を返さないので
   * 常に undefined になり得る。
   */
  readonly code?: string;
  /**
   * 機械可読な失敗理由(例: 'worktree-dirty' / 'already-running')。
   * `error` の人間向け文言はパスなどの可変部分を含むため、クライアントは
   * こちらで分岐する。返さないエンドポイントでは undefined。
   */
  readonly reason?: string;

  constructor(
    status: number,
    message: string,
    options?: {
      body?: string;
      errorMessage?: string;
      detail?: string;
      code?: string;
      reason?: string;
      details?: unknown;
    },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = options?.body;
    this.errorMessage = options?.errorMessage;
    this.detail = options?.detail;
    this.code = options?.code;
    this.reason = options?.reason;
    this.details = options?.details;
  }
}

export async function readErrorPayload(res: Response): Promise<{
  body: string;
  errorMessage?: string;
  detail?: string;
  code?: string;
  reason?: string;
  details?: unknown;
}> {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as {
      error?: unknown;
      detail?: unknown;
      code?: unknown;
      reason?: unknown;
      details?: unknown;
    };
    const errorMessage =
      typeof parsed.error === 'string' ? parsed.error : undefined;
    const detail =
      typeof parsed.detail === 'string' ? parsed.detail : undefined;
    const code = typeof parsed.code === 'string' ? parsed.code : undefined;
    const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
    const details = parsed.details;
    if (
      errorMessage !== undefined ||
      detail !== undefined ||
      code !== undefined ||
      reason !== undefined ||
      details !== undefined
    ) {
      return { body, errorMessage, detail, code, reason, details };
    }
  } catch {
    // non-JSON error body
  }
  return { body };
}

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const { body, errorMessage, detail, code, reason, details } =
      await readErrorPayload(res);
    throw new ApiError(
      res.status,
      errorMessage ?? `HTTP ${res.status} ${res.statusText}: ${path}`,
      { body, errorMessage, detail, code, reason, details },
    );
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}
