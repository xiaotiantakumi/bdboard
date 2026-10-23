---
name: bdboard-phone-url
description: スマホで bdboard を開く接続先 (トンネルのログイン用 URL) を Claude Code から出す。「スマホの接続先を教えて」「スマホで見たい」「スマホ公開して」「トンネルの URL は？」「QR 出して」と言われたら使う。サーバーが止まっていれば起動し、トンネルが張られていなければ張り、張られていればそのまま使って、ワンタイムトークン付き URL を発行する。実体は scripts/phone-url.sh。
---

# bdboard-phone-url — スマホの接続先を Claude Code から出す

画面の「スマホ公開」ボタン (bdboard-y2qx) と同じことをコマンド 1 本で行う。ボタンを押せない
とき (外出先から Claude Code に頼む、ブラウザを開いていない等) のための入口 (bdboard-cyjl)。

## 使い方 (議長のみ)

main checkout でも worktree でもよい (スクリプトは main checkout のサーバーを見に行く)。

```bash
BDBOARD_SERVER_CALLER=chair scripts/phone-url.sh
```

- 標準出力の 1 行目がスマホで開く URL (`https://<ランダム>.trycloudflare.com/?t=<token>&projects=<id,id>`)。
  `projects=` は PC が最後に選んだプロジェクト (サーバーが覚えている `GET /api/ui/selected-projects`) で、
  スマホはその選択で開く (PC が全プロジェクト表示のときは付かない)。
  そのままユーザーに渡す。qrencode が入っていれば QR も標準エラーに出る (`--no-qr` で抑止)。
- トークンはワンタイムで期限付き (期限は標準エラーに出る)。1 回ログインすればその端末は
  cookie で入れる。期限が切れたらもう一度実行すればよい (トンネルは張り直さないので URL の
  ホスト部は変わらない)。

## 何をするか

| 状態 | 動き |
|---|---|
| サーバー停止 (health 000) | `always-on-server.sh start` で起動して health 200 を待つ。`BDBOARD_SERVER_CALLER=chair` が無ければ起動せず exit 2 |
| トンネル off / error | `POST /api/tunnel/start` (パスワード自動) で張り、`on` になるまで最大 60 秒待つ |
| トンネル on | そのまま使う (URL は変わらない) |
| 共通 | `POST /api/tunnel/access-token` でトークンを発行し、`web/src/tunnelQr.ts` の `buildTunnelTokenUrl` と同じ形の URL (PC の選択を `projects=` に付けたもの) を出す |

## 注意

- **URL はログイン情報そのもの**。ユーザー本人への返答以外 (ログ・チケット・コミット・他セッション) に書かない。
- サーバーの起動は議長だけ (skill `bdboard-server-ops`)。サブエージェントはこのスクリプトを
  `BDBOARD_SERVER_CALLER=chair` 付きで打たない。サーバーが動いていればトンネルとトークンの
  部分は誰が打っても同じ結果になる。
- トンネルを止める・再起動でトンネルが落ちる件は `bdboard-server-ops` の
  「cloudflared トンネルの同居確認」。デプロイ後は URL が変わるので、もう一度このスクリプトを打つ。
- `/api/tunnel*` は localhost からしか受け付けない。サーバーと同じ Mac で実行する。
