/**
 * アプリケーション起動時に確定した bdboard 自身のバージョンを提供する。
 * 実装は package manifest など環境固有の情報源を application 層へ漏らさない。
 */
export interface ApplicationVersionProvider {
  getVersion(): string;
}
