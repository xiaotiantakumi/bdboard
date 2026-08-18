/** 単一メトリクス(例: 「Weekly Limit Remaining」)の残量スナップショット。 */
export interface AiQuotaMetric {
  /** 表示ラベル(モデルグループ名を含むことがある。例: "GEMINI MODELS Weekly Limit Remaining") */
  readonly label: string;
  /** 0-100。パースできた場合のみ(「Quota available」のように%が出ない表示もある) */
  readonly percentRemaining?: number;
  /** リセットまでの残り時間の生テキスト(例: "88h 21m")。パース元の表記をそのまま保持する */
  readonly resetInText?: string;
  /** resetInText をパースできた場合の絶対時刻(fetchedAt + 残り時間) */
  readonly resetAt?: Date;
  /** %が出ない「Quota available/exhausted」表示向け */
  readonly status?: 'available' | 'exhausted';
  /** 割合でない取得値(例: Codexの残credit、Unlimited)。 */
  readonly valueText?: string;
}

/** プロバイダの取得状態。manual/unavailable は detail に安全な確認方法を持つ。 */
export type AiQuotaProviderAvailability = 'live' | 'manual' | 'unavailable';

/** `ai-quota all` が返した1プロバイダ分の残量情報。 */
export interface AiQuotaProviderSnapshot {
  readonly id: string;
  readonly label: string;
  readonly vendor?: string;
  readonly plan?: string;
  readonly availability: AiQuotaProviderAvailability;
  /** 手動確認方法、またはライブ取得できなかった場合の案内。アカウント情報は含めない。 */
  readonly detail?: string;
  readonly metrics: readonly AiQuotaMetric[];
}

/** ai-quota コマンドを叩いた生の実行結果全体。 */
export interface AiQuotaSourceResult {
  readonly fetchedAt: Date;
  readonly providers: readonly AiQuotaProviderSnapshot[];
}

/**
 * `ai-quota` (個人環境のクォータ確認CLI) から残量情報を取得するport。
 * コマンド不在/失敗時は例外を投げてよい(呼び出し側のapplication層が捕捉して穏やかに扱う)。
 */
export interface AiQuotaSource {
  fetch(): Promise<AiQuotaSourceResult>;
}
