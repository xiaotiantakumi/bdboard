// src/interface/http/basic-auth.ts は bdboard-sso1.59 でモジュール分割された。
// 実体は ./basic-auth/ 配下:
//   - types.ts               : BasicAuthConfig / AuthMode / BasicAuthMiddlewareOptions (公開型)
//   - auth-mode.ts            : 環境変数から認証モードを決める resolveAuthMode()
//   - credentials.ts          : Basic 認証ヘッダーのパース・定数時間比較 (parseBasicAuth /
//     validateAgainstPrimaryAndExtra)
//   - enabled-auth-handler.ts : enabled モード用ハンドラ本体。ブルートフォース抑制の
//     可変状態(スロットル)を保持するクロージャ (createEnabledAuthHandler)
//   - middleware.ts           : モード別分岐・isLocalRequest バイパスを含む Hono
//     ミドルウェア構築 (createBasicAuthMiddleware 本体)
// このファイルは import 側 (呼び出し元・テスト) を書き換えないための入口としてのみ残す。
// 挙動・型は一切変えていない (移動のみ)。
export type {
  BasicAuthConfig,
  AuthMode,
  BasicAuthMiddlewareOptions,
} from './basic-auth/types.js';
export { resolveAuthMode } from './basic-auth/auth-mode.js';
export { createBasicAuthMiddleware } from './basic-auth/middleware.js';
