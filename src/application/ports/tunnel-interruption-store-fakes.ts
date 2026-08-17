import type { TunnelInterruptionStore } from './tunnel-interruption-store.js';

/** テスト用: メモリ上に中断記録を保持する */
export function createInMemoryTunnelInterruptionStore(): TunnelInterruptionStore & {
  readonly interruptedAt: Date | null;
} {
  let interruptedAt: Date | null = null;

  return {
    get interruptedAt() {
      return interruptedAt;
    },
    read(): Date | null {
      return interruptedAt;
    },
    markInterrupted(at: Date): void {
      interruptedAt = at;
    },
    clear(): void {
      interruptedAt = null;
    },
  };
}
