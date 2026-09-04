import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  CHAT_AGENT_AUTH_FAILURE_HELP,
  CHAT_BUSY_HELP,
  CONFLICT_WRITE_HELP,
  CROSS_SITE_HELP,
  NETWORK_FETCH_HELP,
  RATE_LIMITED_HELP,
  REMOTE_AGENT_RUNS_DISABLED_HELP,
  TUNNEL_NOT_RUNNING_HELP,
  TUNNEL_WRITE_HELP,
  chatAgentErrorMessage,
  describeWriteError,
  isNetworkFetchError,
  writeAccessErrorMessage,
} from './writeAccessMessage';

function apiError(
  status: number,
  errorMessage?: string,
  options?: { code?: string },
): ApiError {
  return new ApiError(status, errorMessage ?? `HTTP ${status}`, {
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...options,
  });
}

describe('writeAccessErrorMessage', () => {
  it('explains the tunnel authorization 403 for writes and for chat', () => {
    expect(writeAccessErrorMessage(apiError(403, 'local access only'))).toBe(
      TUNNEL_WRITE_HELP,
    );
    expect(
      writeAccessErrorMessage(
        apiError(403, 'chat requires local access or an authorized tunnel session'),
      ),
    ).toBe(TUNNEL_WRITE_HELP);
  });

  it('names the QR entrance and the password length as the two fixes', () => {
    expect(TUNNEL_WRITE_HELP).toContain('QRコード');
    expect(TUNNEL_WRITE_HELP).toContain('12文字未満');
    expect(TUNNEL_WRITE_HELP).not.toContain('手入力');
  });

  it('explains the CSRF 403 separately', () => {
    expect(
      writeAccessErrorMessage(apiError(403, 'cross-site write blocked')),
    ).toBe(CROSS_SITE_HELP);
    expect(
      writeAccessErrorMessage(apiError(403, 'cross-site chat request blocked')),
    ).toBe(CROSS_SITE_HELP);
  });

  it('explains the remote agent runs disabled 403', () => {
    expect(
      writeAccessErrorMessage(apiError(403, 'remote agent runs are disabled')),
    ).toBe(REMOTE_AGENT_RUNS_DISABLED_HELP);
  });

  it('leaves other errors to the caller', () => {
    expect(writeAccessErrorMessage(apiError(409, 'conflict'))).toBeNull();
    expect(writeAccessErrorMessage(apiError(403, 'something else'))).toBeNull();
    expect(writeAccessErrorMessage(new Error('boom'))).toBeNull();
    expect(writeAccessErrorMessage(undefined)).toBeNull();
  });

  it('explains the rate-limit 429', () => {
    expect(writeAccessErrorMessage(apiError(429, 'chat rate limit exceeded'))).toBe(
      RATE_LIMITED_HELP,
    );
  });
});

describe('describeWriteError', () => {
  it('prefers the authorization explanation', () => {
    expect(
      describeWriteError(apiError(403, 'local access only'), 'fallback'),
    ).toBe(TUNNEL_WRITE_HELP);
  });

  it('explains network fetch failures in Japanese', () => {
    expect(
      describeWriteError(new TypeError('Failed to fetch'), 'fallback'),
    ).toBe(NETWORK_FETCH_HELP);
    expect(describeWriteError(new TypeError('Load failed'), 'fallback')).toBe(
      NETWORK_FETCH_HELP,
    );
  });

  it('explains 409 conflicts in Japanese', () => {
    expect(describeWriteError(apiError(409, 'conflict'), 'fallback')).toBe(
      CONFLICT_WRITE_HELP,
    );
  });

  it('dispatches the tunnel-not-running 409 to its own message (bdboard-o2o)', () => {
    expect(
      describeWriteError(apiError(409, 'tunnel is not running'), 'fallback'),
    ).toBe(TUNNEL_NOT_RUNNING_HELP);
  });

  it('dispatches the chat-busy 409 to its own message (bdboard-o2o)', () => {
    expect(
      describeWriteError(
        apiError(409, 'chat is busy for this project'),
        'fallback',
      ),
    ).toBe(CHAT_BUSY_HELP);
  });

  it('falls back to CONFLICT_WRITE_HELP for issue-writer style and unknown 409 strings', () => {
    expect(
      describeWriteError(
        apiError(409, 'status changed since quick action'),
        'fallback',
      ),
    ).toBe(CONFLICT_WRITE_HELP);
    expect(
      describeWriteError(
        apiError(409, 'priority changed since quick action'),
        'fallback',
      ),
    ).toBe(CONFLICT_WRITE_HELP);
    expect(
      describeWriteError(
        apiError(409, 'some future unknown conflict string'),
        'fallback',
      ),
    ).toBe(CONFLICT_WRITE_HELP);
    // No errorMessage at all still falls back safely.
    expect(describeWriteError(apiError(409), 'fallback')).toBe(
      CONFLICT_WRITE_HELP,
    );
  });

  it('falls back to the server message, then the error message, then the fallback', () => {
    expect(describeWriteError(new Error('boom'), 'fallback')).toBe('boom');
    expect(describeWriteError(null, 'fallback')).toBe('fallback');
  });

  it('explains the rate-limit 429 without using the fallback', () => {
    expect(
      describeWriteError(apiError(429, 'chat rate limit exceeded'), 'fallback'),
    ).toBe(RATE_LIMITED_HELP);
  });
});

describe('chatAgentErrorMessage', () => {
  it('maps chat agent unavailable and CLI exit failures to auth-oriented help', () => {
    expect(
      chatAgentErrorMessage(apiError(503, 'chat agent unavailable')),
    ).toBe(CHAT_AGENT_AUTH_FAILURE_HELP);
    expect(
      chatAgentErrorMessage(
        apiError(502, 'chat failed', { code: 'agent-exit-nonzero' }),
      ),
    ).toBe(CHAT_AGENT_AUTH_FAILURE_HELP);
    expect(
      chatAgentErrorMessage(
        apiError(502, 'chat failed', { code: 'agent-not-found' }),
      ),
    ).toBe(CHAT_AGENT_AUTH_FAILURE_HELP);
    expect(
      chatAgentErrorMessage(
        apiError(502, 'chat failed', { code: 'agent-workspace-untrusted' }),
      ),
    ).toBeNull();
  });
});

describe('isNetworkFetchError', () => {
  it('detects browser-specific fetch TypeError messages', () => {
    expect(isNetworkFetchError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkFetchError(new TypeError('Load failed'))).toBe(true);
    expect(
      isNetworkFetchError(
        new TypeError('NetworkError when attempting to fetch resource'),
      ),
    ).toBe(true);
    expect(isNetworkFetchError(new Error('Failed to fetch'))).toBe(false);
    expect(isNetworkFetchError(new TypeError('boom'))).toBe(false);
  });
});
