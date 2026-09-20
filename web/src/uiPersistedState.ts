// web/src/uiPersistedState.ts は bdboard-sso1.26 でモジュール分割された。実体は ./uiPersistedState/ 配下。
// このファイルは import 側 (コンポーネント・hooks・テスト) を書き換えないための
// re-export 入口としてのみ残す。挙動・型は一切変えていない (移動のみ)。
export * from './uiPersistedState/view';
export * from './uiPersistedState/listOptions';
export * from './uiPersistedState/storageKeys';
export * from './uiPersistedState/validators';
export * from './uiPersistedState/priorityCeiling';
export * from './uiPersistedState/recentTickets';
export * from './uiPersistedState/boardFilterPreset';
export * from './uiPersistedState/boardFilterPresetMatch';
