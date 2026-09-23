// src/infrastructure/transcript/jsonl-transcript-scanner.ts は bdboard-sso1.72 でモジュール分割された。
// 実体は ./jsonl-transcript-scanner/ 配下:
//   - types.ts            : ScannerDeps 等の内部型 (ScannerOptions / TargetMeta /
//     TargetWithProject / ScannerDeps はいずれもモジュール内部専用。公開型なし)
//   - session-id.ts        : sessionIdFromFileName
//   - subagent-targets.ts  : collectSubagentTargets
//   - link-dedupe.ts       : dedupeAndSortLinks
//   - collect-targets.ts   : collectScanTargets() (走査対象の収集ループ)
//   - process-slices.ts    : processScanSlices() (slice の解釈・cache オフセット更新ループ)
//   - scanner.ts           : createJsonlTranscriptScanner() 本体 (上記を組み合わせるワークフロー)
// このファイルは import 側 (呼び出し元・テスト) を書き換えないための入口としてのみ残す。
// 挙動・型は一切変えていない (移動のみ)。
export { createJsonlTranscriptScanner } from './jsonl-transcript-scanner/scanner.js';
