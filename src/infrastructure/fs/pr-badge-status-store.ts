import fs from 'node:fs';
import path from 'node:path';
import type { PersistedPrBadgeStatusEntry } from '../../application/board/pr-badge-status-cache.js';

/**
 * bdboard-ye2p: PrBadgeStatusCache の terminal (permanent) エントリを、サーバー
 * 再起動をまたいで残すための軽量 JSON ファイルストア。tunnel-interruption-store.ts
 * と同じ方針 — dbPath (既定 ~/.bdboard/cache.db, BDBOARD_DB で上書き可) の隣に
 * 置く薄いファイルで、読み書き失敗・JSON 破損はすべて握りつぶして劣化させる
 * (都度取得に戻るだけで起動やバッジ表示自体は落とさない)。
 *
 * sqlite-board-cache (スキーマ/マイグレーション付きの重い抽象) ではなくこの形を
 * 選んだ理由: 保存対象は「URL → 恒久化した1エントリ」のフラットな配列だけで、
 * スキーマ進化やクエリが要らない。dbPath 由来のパスにしたことで、一時サーバー
 * (別ポート・別 BDBOARD_DB) が常駐サーバーのファイルと衝突しない分離も
 * 追加コード無しで手に入る。
 */
interface PrBadgeStatusFileShape {
  readonly entries?: unknown;
}

export interface PrBadgeStatusStore {
  read(): readonly PersistedPrBadgeStatusEntry[];
  write(entries: readonly PersistedPrBadgeStatusEntry[]): void;
}

export function createFilePrBadgeStatusStore(filePath: string): PrBadgeStatusStore {
  const read = (): readonly PersistedPrBadgeStatusEntry[] => {
    try {
      if (!fs.existsSync(filePath)) {
        return [];
      }
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(content) as PrBadgeStatusFileShape;
      if (!Array.isArray(parsed.entries)) {
        return [];
      }
      // 個々のエントリの形の検証は呼び出し側 (PrBadgeStatusCache の
      // initialEntries、isValidPersistedEntry) に任せる — ここではファイル
      // 全体が読めて配列になっていることだけを保証する。
      return parsed.entries as readonly PersistedPrBadgeStatusEntry[];
    } catch {
      return [];
    }
  };

  const write = (entries: readonly PersistedPrBadgeStatusEntry[]): void => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ entries }), 'utf8');
    } catch {
      // 書き込み失敗はプロセスを落とさない — 次回起動時はまた都度取得に戻るだけ。
    }
  };

  return { read, write };
}
