// src/infrastructure/process/ai-quota-source.ts は bdboard-sso1.42 でモジュール分割された。
// 実体は ./ai-quota-source/ 配下:
//   - types.ts                : NodeAiQuotaSourceOptions (公開型) と内部型
//     (ProviderBlock / ParsedBlockContent)
//   - duration-parsing.ts     : 相対/絶対リセット時刻のパース (parseDurationMs /
//     parseAbsoluteResetAt)
//   - block-extraction.ts     : stdout からのプロバイダブロック抽出とヘッダ解析
//     (extractProviderBlocks / parseHeader)
//   - block-content-parser.ts : ブロック本文のメトリクス/可用性解析 (parseBlockContent)
//   - parse-output.ts         : parseAiQuotaOutput() 本体 (上記を組み合わせるワークフロー)
//   - node-source.ts          : createNodeAiQuotaSource() 本体とデフォルト定数
// このファイルは import 側 (呼び出し元・テスト) を書き換えないための入口としてのみ残す。
// 挙動・型は一切変えていない (移動のみ)。
export type { NodeAiQuotaSourceOptions } from './ai-quota-source/types.js';
export { parseAiQuotaOutput } from './ai-quota-source/parse-output.js';
export { createNodeAiQuotaSource } from './ai-quota-source/node-source.js';
