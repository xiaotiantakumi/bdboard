import { EventEmitter } from 'node:events';
import type { SpawnedProcess } from './cloudflared-tunnel.js';

export function createFakeSpawnedProcess(
  handlers: {
    readonly onKill?: (signal?: NodeJS.Signals) => void;
  } = {},
): SpawnedProcess & {
  readonly emitter: EventEmitter;
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
  emitClose: (code: number | null) => void;
  emitError: (err: Error) => void;
} {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  const processHandle: SpawnedProcess & {
    readonly emitter: EventEmitter;
    emitStdout: (chunk: string) => void;
    emitStderr: (chunk: string) => void;
    emitClose: (code: number | null) => void;
    emitError: (err: Error) => void;
  } = {
    emitter,
    stdout,
    stderr,
    kill: (signal?: NodeJS.Signals) => {
      handlers.onKill?.(signal);
      return true;
    },
    on: (event, listener) => {
      emitter.on(event, listener as never);
      return processHandle;
    },
    emitStdout: (chunk: string) => {
      stdout.emit('data', chunk);
    },
    emitStderr: (chunk: string) => {
      stderr.emit('data', chunk);
    },
    emitClose: (code: number | null) => {
      emitter.emit('close', code);
    },
    emitError: (err: Error) => {
      emitter.emit('error', err);
    },
  };

  return processHandle;
}
