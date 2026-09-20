// web/src/api.ts は bdboard-sso1.4 でモジュール分割された。実体は ./api/ 配下。
// このファイルは import 側 (コンポーネント・hooks・テスト) を書き換えないための
// re-export 入口としてのみ残す。挙動・型は一切変えていない (移動のみ)。
export { ApiError } from './api/http';
export * from './api/board';
export * from './api/sessions';
export * from './api/tickets-read';
export * from './api/tickets-write';
export * from './api/decisions';
export * from './api/attachments';
export * from './api/stats';
export * from './api/hygiene';
export * from './api/harness';
export * from './api/agent-run';
export * from './api/settings';
export * from './api/tunnel';
export * from './api/chat';
