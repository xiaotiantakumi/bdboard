// src/infrastructure/process/ps-process-scanner.ts は bdboard-sso1.47 でモジュール分割された。
// 実体は ./ps-process-scanner/ 配下:
//   - types.ts                 : PsProcessScannerOptions (公開型) と内部型
//     (PsRow / PsRawRow / HeartbeatPidfileRecord)
//   - agent-matching.ts        : エージェントコマンド判定 (tokenBasename / matchesAgentCommand)
//   - heartbeat-loop-command.ts: bd-heartbeat ループコマンドの判定 (isHeartbeatLoopCommand)
//   - ps-output.ts             : ps 出力のパース (parseLstart / parsePsRawLines / parsePsOutput)
//   - lsof-output.ts           : lsof 出力のパース (parseLsofOutput)
//   - heartbeat-pidfile.ts     : bd-heartbeat pidfile ディレクトリの読み取り
//     (defaultHeartbeatStateDir / readHeartbeatPidfileMap)
//   - scanner.ts               : createPsProcessScanner() 本体 (上記を組み合わせるワークフロー)
// このファイルは import 側 (呼び出し元・テスト) を書き換えないための入口としてのみ残す。
// 挙動・型は一切変えていない (移動のみ)。
export type { PsProcessScannerOptions } from './ps-process-scanner/types.js';
export { createPsProcessScanner } from './ps-process-scanner/scanner.js';
