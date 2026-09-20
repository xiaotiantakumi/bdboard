// src/infrastructure/chat/bd-tool-catalog.ts は bdboard-sso1.18 でモジュール分割された。
// 実体は ./bd-tool-catalog/ 配下:
//   - types.ts                : 公開型 (BdToolDefinition / BdArgsBuildResult)
//   - schemas.ts               : 各ツールの入力を検証する zod スキーマと定数/パースヘルパー
//   - args-helpers.ts          : buildBdToolArgs の結果組み立て・zod エラー要約・CLI 引数の接頭辞
//   - read-tools.ts            : bd_list / bd_ready / bd_blocked / bd_show / bd_search (読み取り系)
//   - lifecycle-tools.ts       : bd_update_status / bd_claim / bd_close (状態遷移系)
//   - content-tools.ts         : bd_update_title / bd_update_description / bd_append_notes /
//                                 bd_comment (本文編集系)
//   - schedule-label-tools.ts  : bd_defer / bd_priority / bd_label_add / bd_label_remove
//   - create-dep-tools.ts      : bd_create / bd_dep_add / bd_dep_remove (新規作成/依存関係系)
//   - index.ts                 : 上記の合成層 (BD_TOOL_DEFINITIONS の並び順の再現を含む)
// (200 行の ESLint max-lines 上限に収めるため、ツール群は writes:false/true と実際の
// 変更理由の塊で5分割している)。このファイルは import 側 (呼び出し元・テスト) を
// 書き換えないための入口としてのみ残す。挙動・型は一切変えていない (移動のみ)。
//
// BD_TOOL_DEFINITIONS は AI (チャットエージェント) へ渡るプロンプトの一部であり、配列の
// 並び順と各ツールの name/description/inputSchema が分割前後で1文字も変わっていないことは
// bd-tool-catalog.catalogSnapshot.test.ts が sha256 で固定する。
export type { BdToolDefinition, BdArgsBuildResult } from './bd-tool-catalog/index.js';
export { BD_TOOL_DEFINITIONS, buildBdToolArgs } from './bd-tool-catalog/index.js';
