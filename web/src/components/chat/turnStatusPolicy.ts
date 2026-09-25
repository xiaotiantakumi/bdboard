// bdboard-sso1.83 第4段: ChatPanel.tsx から純粋な定数を移動しただけのファイル。
// 挙動は一切変えていない。

// bdboard-3tw.164: turn-status の取得が一時的に失敗しても (ネットワークエラー /
// 一時的な 5xx 等) ポーリングを止めずに再試行するためのバックオフ表。要素数が
// そのまま再試行回数の上限になる (この配列なら5回)。値を使い切ってもなお失敗が
// 続く場合はこのポーリング自体を諦める — このポーリングは「取れれば儲けもの」の
// 付加的な回収経路であり、無限リトライでサーバーを叩き続けるより安全側に倒す。
// 送信元スレッドの sessionId が既知なら (=新規スレッドの最初の送信でなければ)
// unresolvedSends 経由の履歴再取得安全網 (bdboard-3tw.156) がスレッド閲覧時に
// 拾えるが、sessionId 未確定の新規スレッドはこの安全網の対象外 (markUnresolvedSend
// は sessionId undefined を no-op で無視する) — 諦めた場合そちらは回収されない。
export const TURN_STATUS_POLL_RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 8_000];

// bdboard-96rp (Opus レビュー指摘 B2): sessionId 未確定の送信を detachedAt (クライアント
// の Date.now()) と status.failedAt/completedAt (サーバーの時刻) を突き合わせて絞り込む
// 際、両者は別プロセス・別マシン (モバイルトンネル経由のクライアントもあり得る) の
// クロックなので、わずかな時刻ずれで「本当は自分の送信の結果なのに detachedAt より
// わずかに前の時刻として記録され、取りこぼす」誤判定が起き得る。実用上あり得るずれ幅
// より十分大きいマージンを許容側に加えることで、取りこぼしより「多少広めに一致させる」
// 方に倒す (単一ロックの isBusy により、この許容幅の中で無関係な別ターンの結果と
// 衝突するリスクは実質無い)。
export const TURN_STATUS_CLOCK_SKEW_TOLERANCE_MS = 30_000;

// bdboard-96rp (round 2 再レビューで発見されたブロッカー): sessionId 未確定の
// tracked send が、自分自身の sessionId 無し failed と時刻的に一致しない場合
// (TURN_STATUS_CLOCK_SKEW_TOLERANCE_MS を超えるずれ — 上のコメント群が言う
// cloudflared トンネル越しの切断検知遅延等)、chat/useTurnStatusRecovery.ts のターン状態
// ポーリング用 useEffect にある 'failed' 分岐は「無関係かもしれない
// ので ACK せず何もしない」まま1秒間隔でポーリングを続け続ける。sessionId 無しの
// エントリは ACK 経路が無く、bdboard-96rp B1 の dedupe によりサーバーはこの1件を
// 置き換わるまで返し続けるので、これが本当に自分自身の (時刻がずれて観測された)
// 失敗だった場合、何も置き換えが起きず無期限に一致しないまま — 送信ボタンが
// 二度と解放されない実質的なデッドロックになる。これを避けるため、「一致しない
// sessionId 無し failed」を一定回数 (=一定時間) 観測し続けたら、時刻の厳密な
// 一致を諦めてこのエントリを自分自身の失敗として受け入れる。誤って無関係な
// エントリを受け入れてしまうリスクはあるが、単一ロック (isBusy) 下でこの猶予
// 時間の間ずっと同じ sessionId 無し failed が居座り続けるのは「本当に自分自身の
// 失敗が遅れて観測されている」可能性の方が、他プロジェクトクライアントが偶然
// 同じ猶予時間内に別の sessionId 無し失敗を起こす可能性より高いと判断した —
// 無期限に沈黙してハングし続けるより、猶予後に (多少不正確でも) 解決して
// 利用者に再送の機会を与える方を優先する。
export const UNMATCHED_SESSIONLESS_FAILED_GIVEUP_POLLS = 20;
// ↑ 1秒間隔のポーリングなので実測で約20秒の猶予。既存の
// TURN_STATUS_POLL_RETRY_BACKOFF_MS (5回・合計約23秒) と同じ桁数に揃えた —
// この値そのものに強い根拠は無く、「無期限にブロックしない」ことが目的の
// 主眼であり、猶予の長さは今後の実測次第で調整して良い。
// この値を上げるときは src/interface/http/chat-turn-tracker.ts の
// FAILED_TURN_SESSIONLESS_TTL_MS (60s) より十分短く保つこと — 追い越すと
// サーバー側の TTL 刈り取りとクライアント側の自己解決が競合しうる (bdboard-kg0m)。

// bdboard-zlzo: 配信停止後にサーバー側でもターンの完了を確認できなかったときの文言。
export const CHAT_STREAM_DETACHED_FAILED_MESSAGE =
  '返信の受信が途中で途切れ、サーバー側でも返信の完了を確認できませんでした。もう一度送信してください。';
