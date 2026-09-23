// bdboard-sso1.57: createCloudflaredTunnel() から切り出した、stdout/stderr ハンドラ登録・
// 起動タイムアウトタイマー・URL 検出・成功しなかった場合の kill (stop 経由) の関心。
// 「一度 settle したら二度と resolve/reject しない」「タイムアウトしたら stop() してから
// reject する」「URL 検出前にプロセスが閉じたら失敗として扱う」「URL 検出後に閉じた場合のみ
// 予期しない終了として通知する」という判定は、元の createCloudflaredTunnel() 内の Promise
// executor が持っていたものをそのまま移した(挙動は変えていない)。
import type { TunnelStartResult } from '../../../application/ports/tunnel.js';
import type { SpawnedProcess } from './spawned-process.js';
import type { LogSink } from './log-sink.js';
import { maskSecrets } from './log-sink.js';
import { appendStartupOutputBuffer, extractTunnelUrl } from './startup-buffer.js';
import { notifyUnexpectedExit, type TunnelRuntimeState } from './runtime-state.js';

export interface WaitForTunnelUrlOptions {
  readonly processHandle: SpawnedProcess;
  readonly state: TunnelRuntimeState;
  readonly logSink: LogSink;
  readonly startTimeoutMs: number;
  readonly stop: () => Promise<void>;
}

export function waitForTunnelUrl(
  options: WaitForTunnelUrlOptions,
): Promise<TunnelStartResult> {
  const { processHandle, state, logSink, startTimeoutMs, stop } = options;

  return new Promise<TunnelStartResult>((resolve, reject) => {
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      void stop().finally(() => {
        reject(err);
      });
    };

    const succeed = (url: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      resolve({ url });
    };

    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      logSink.write(maskSecrets(text));

      if (settled) {
        return;
      }

      state.outputBuffer = appendStartupOutputBuffer(state.outputBuffer, chunk);
      const url = extractTunnelUrl(state.outputBuffer);
      if (url !== null) {
        state.outputBuffer = '';
        succeed(url);
      }
    };

    const timeoutTimer = setTimeout(() => {
      fail(new Error('timed out waiting for cloudflared tunnel URL'));
    }, startTimeoutMs);

    processHandle.stdout?.on('data', onData);
    processHandle.stderr?.on('data', onData);

    processHandle.on('error', (err) => {
      fail(err);
    });

    processHandle.on('close', (code) => {
      logSink.write(`[${new Date().toISOString()}] cloudflared exited (code=${String(code)})\n`);
      logSink.close();

      if (!settled) {
        fail(
          new Error(
            `cloudflared exited before publishing a URL (code=${String(code)})`,
          ),
        );
        return;
      }

      // 起動成功後の close: このハンドルがまだ「現在のトンネル」として追跡されている
      // (= 自分たちが stop() を呼んで child をクリアしていない)場合のみ、予期せぬ終了と
      // みなす。stop() は kill 前に child を null にするため、意図した停止ではここに
      // 入らない。
      if (state.child === processHandle) {
        state.child = null;
        state.outputBuffer = '';
        notifyUnexpectedExit(state);
      }
    });
  });
}
