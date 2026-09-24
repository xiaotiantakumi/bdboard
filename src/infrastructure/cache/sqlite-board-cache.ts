// src/infrastructure/cache/sqlite-board-cache.ts は bdboard-sso1.19 でモジュール分割された。
// 実体は ./sqlite-board-cache/ 配下:
//   - schema.ts : SCHEMA_VERSION・テーブル定義・openCacheDatabase (再構築判定含む)
//   - schema-migrations.ts : 列追加の in-place マイグレーション (ensure*Column、schema.ts から呼ぶ)
//   - row-types.ts : DB 行の型定義 (schema*.ts / convert.ts / read.ts / write*.ts が共有)
//   - convert.ts : 行 → ドメインオブジェクトの変換 (rowToCachedProject 等)
//   - read.ts   : 読み取りクエリ (getProject / listProjects / getCacheStats 等)
//   - write.ts  : 書き込み (upsert / 無効化。putProject / clear / putCfdSnapshot 等)
//   - write-links.ts : session_links / interactions の書き込みと MAX_INTERACTIONS
//     (件数上限までの trim を含み、write.ts から呼ばれる)
// このファイルは import 側 (呼び出し元・テスト) を書き換えないための入口としてのみ残す。
// SQL 文字列・マイグレーションの順序・トランザクション境界・prepared statement の生成
// タイミング (コンストラクタで一度) は一切変えていない (移動のみ)。
//
// createSqliteBoardCache() は元々クラスではなく、db 接続をクロージャで捕捉して BoardCache
// を実装するオブジェクトファクトリだった。分割にあたり、公開 API (関数名・引数・戻り値の形)
// とコンストラクタ引数 (dbPath) は変えず、prepared statement の生成と各メソッドの本体を
// createReadOperations / createWriteOperations という2つのサブファクトリへ委譲する形にした
// (どちらも db を明示引数として受け取り、呼び出しは1回だけ — 生成タイミングは変わらない)。
import type { BoardCache } from '../../application/ports/board-cache.js';
import { createReadOperations } from './sqlite-board-cache/read.js';
import { createParseCache } from './sqlite-board-cache/parse-cache.js';
import { createWriteOperations } from './sqlite-board-cache/write.js';
import { openCacheDatabase } from './sqlite-board-cache/schema.js';

export { MAX_INTERACTIONS } from './sqlite-board-cache/write.js';
export { openCacheDatabase } from './sqlite-board-cache/schema.js';

export function createSqliteBoardCache(dbPath: string): BoardCache {
  const db = openCacheDatabase(dbPath);

  const parseCache = createParseCache();
  const readOperations = createReadOperations(db, dbPath, parseCache);
  const writeOperations = createWriteOperations(db, parseCache);

  return {
    ...readOperations,
    ...writeOperations,

    close(): void {
      db.close();
    },
  };
}
