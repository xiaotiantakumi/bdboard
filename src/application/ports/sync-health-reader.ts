import type { SyncHealthSignals } from '../../domain/sync-health.js';

export interface SyncHealthReader {
  /** rootPath配下のgit/.beadsを読み取り専用で調べ、生シグナルを返す。副作用(fetch等)は行わない */
  readSignals(rootPath: string): Promise<SyncHealthSignals>;
}
