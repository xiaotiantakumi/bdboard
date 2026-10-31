#!/usr/bin/env bash
# phone-url.sh — スマホで bdboard を開くための接続先 (ログイン用トークン付き URL) を出す (bdboard-cyjl)。
#
#   BDBOARD_SERVER_CALLER=chair scripts/phone-url.sh [--port N] [--no-qr]
#
# 1. 常時稼働サーバーが止まっていれば (health が 000) always-on-server.sh start で起動する。
#    起動は議長だけの操作なので BDBOARD_SERVER_CALLER=chair が無いときは起動せず exit 2。
# 2. トンネルが off なら POST /api/tunnel/start で張る (画面の「スマホ公開」と同じ。パスワードは自動)。
#    既に on ならそのまま使う (URL は変わらない)。
# 3. POST /api/tunnel/access-token でワンタイムのトークンを発行し、画面の QR と同じ URL
#    (認証情報を外して ?t=<token> と、PC の現在のプロジェクト選択 &projects=<id,id> を付けたもの) を出す。qrencode があれば端末に QR も出す。
#
# /api/tunnel は localhost からしか叩けない (tunnel-routes.ts の localOnlyGuard) ので、
# このスクリプトもサーバーと同じマシンで動かす。
set -euo pipefail

PORT="${BDBOARD_PORT:-8787}"
SHOW_QR=1
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --no-qr) SHOW_QR=0; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "phone-url: unknown option: $1" >&2; exit 64 ;;
  esac
done

BASE="http://localhost:${PORT}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# worktree から呼ばれても常時稼働サーバーは main checkout のもの。
MAIN_CHECKOUT="$(cd "$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"

health_code() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${BASE}/api/health" 2>/dev/null || true
}

json_field() {
  python3 -c 'import json,sys; v=json.load(sys.stdin).get(sys.argv[1]); print("" if v is None else v)' "$1"
}

# --- 1. サーバー ---------------------------------------------------------------
code="$(health_code)"
if [ "$code" = "000" ] || [ -z "$code" ]; then
  if [ "${BDBOARD_SERVER_CALLER:-}" != "chair" ]; then
    echo "phone-url: サーバーが止まっています。起動は議長だけが行えます (BDBOARD_SERVER_CALLER=chair を付けて再実行)。" >&2
    exit 2
  fi
  echo "phone-url: サーバーが止まっているので起動します…" >&2
  BDBOARD_SERVER_CALLER=chair "${MAIN_CHECKOUT}/scripts/always-on-server.sh" start --port "$PORT" >&2
  for _ in $(seq 1 60); do
    code="$(health_code)"
    [ "$code" = "200" ] && break
    sleep 2
  done
fi
if [ "$code" != "200" ]; then
  echo "phone-url: サーバーの health が ${code} です。skill bdboard-server-ops の手順で確認してください。" >&2
  exit 1
fi

# --- 2. トンネル ---------------------------------------------------------------
ensure_tunnel() {
state_json="$(curl -sS --max-time 40 "${BASE}/api/tunnel")"
state="$(printf '%s' "$state_json" | json_field state)"
if [ "$(printf '%s' "$state_json" | json_field authEnabled)" != "True" ]; then
  echo "phone-url: Basic 認証が無効なのでトンネルを張れません (BDBOARD_AUTH_* を確認)。" >&2
  exit 1
fi
case "$state" in
  unavailable)
    echo "phone-url: cloudflared が見つかりません (brew install cloudflared)。" >&2
    exit 1 ;;
  on) ;;
  *)
    if [ "$state" != "starting" ]; then
      echo "phone-url: トンネルを開始します…" >&2
      curl -sS --max-time 60 -X POST -H 'content-type: application/json' -d '{}' \
        "${BASE}/api/tunnel/start" >/dev/null
    fi
    for _ in $(seq 1 30); do
      state_json="$(curl -sS --max-time 40 "${BASE}/api/tunnel")"
      state="$(printf '%s' "$state_json" | json_field state)"
      [ "$state" = "on" ] || [ "$state" = "error" ] && break
      sleep 2
    done ;;
esac
if [ "$state" != "on" ]; then
  echo "phone-url: トンネルが起動しませんでした (state=${state} $(printf '%s' "$state_json" | json_field message))。" >&2
  exit 1
fi
tunnel_url="$(printf '%s' "$state_json" | json_field url)"
tunnel_degraded="$(printf '%s' "$state_json" | json_field degraded)"
}

# bdboard-7yfj.8: 発行した URL が外から届くか確かめる。cloudflared が再試行ループに入ると
# /api/tunnel は state=on のまま (degraded だけ立つ) で、URL は 530/000 になる。
# 1.1.1.1 で引いた IP に --resolve して /api/health を叩き、200/401 なら OK
# (ローカル DNS のネガティブキャッシュに引きずられない)。dig が無ければ確認を省く。
REACH_DETAIL=""
tunnel_reachable() {
  if [ "$tunnel_degraded" = "True" ]; then
    REACH_DETAIL="トンネルが degraded です ($(printf '%s' "$state_json" | json_field lastError))"
    return 1
  fi
  if ! command -v dig >/dev/null 2>&1; then
    echo "phone-url: dig が無いので到達確認を省きます。" >&2
    return 0
  fi
  local host ip rc
  host="$(printf '%s' "$tunnel_url" | python3 -c 'import sys,urllib.parse as u; print(u.urlsplit(sys.stdin.read().strip()).hostname or "")')"
  for _ in $(seq 1 15); do
    ip="$(dig +short @1.1.1.1 "$host" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)"
    if [ -n "$ip" ]; then
      rc="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "${host}:443:${ip}" "https://${host}/api/health" 2>/dev/null || true)"
      if [ "$rc" = "200" ] || [ "$rc" = "401" ]; then
        return 0
      fi
      REACH_DETAIL="https://${host}/api/health が ${rc:-000} (ip=${ip})"
    else
      REACH_DETAIL="${host} を 1.1.1.1 で引けません"
    fi
    sleep 2
  done
  return 1
}

ensure_tunnel
if ! tunnel_reachable; then
  echo "phone-url: トンネルに届きません (${REACH_DETAIL})。停止して作り直します (1 回だけ)…" >&2
  curl -sS --max-time 60 -X POST "${BASE}/api/tunnel/stop" >/dev/null || true
  ensure_tunnel
  if ! tunnel_reachable; then
    echo "phone-url: 作り直してもトンネルに届きません (${REACH_DETAIL})。cloudflared のログ (~/.bdboard/logs/cloudflared-tunnel.log) を確認してください。" >&2
    exit 1
  fi
fi

# --- 3. トークン付き URL ---------------------------------------------------------
token_json="$(curl -sS --max-time 10 -X POST "${BASE}/api/tunnel/access-token")"
token="$(printf '%s' "$token_json" | json_field token)"
expires="$(printf '%s' "$token_json" | json_field expiresAt)"
if [ -z "$token" ]; then
  echo "phone-url: トークンを発行できませんでした: ${token_json}" >&2
  exit 1
fi
# web/src/tunnelQr.ts の buildTunnelTokenUrl と同じ組み立て (認証情報を外して ?t= を付ける)。
# bdboard-u8p9: PC が最後に申告したプロジェクト選択 (GET /api/ui/selected-projects) を
# `projects=<id>,<id>` (ID は URL エンコード、区切りは生の `,`) として付ける。空・未申告・取得失敗なら付けない。
selected_json="$(curl -sS --max-time 5 "${BASE}/api/ui/selected-projects" 2>/dev/null || true)"
phone_url="$(printf '%s' "$selected_json" | python3 -c '
import sys, json, urllib.parse as u
try:
    ids = json.loads(sys.stdin.read() or "null").get("projectIds") or []
except Exception:
    ids = []
p = u.urlsplit(sys.argv[1])
host = p.hostname + (":%d" % p.port if p.port else "")
query = u.urlencode(u.parse_qsl(p.query) + [("t", sys.argv[2])])
if ids:
    query += "&projects=" + ",".join(u.quote(str(i), safe="") for i in ids)
print(u.urlunsplit((p.scheme, host, p.path or "/", query, p.fragment)))
' "$tunnel_url" "$token")"

echo "$phone_url"
echo "phone-url: トークンの有効期限 ${expires} (1 回ログインすればその後は cookie で入れます)" >&2
if [ "$SHOW_QR" = "1" ] && command -v qrencode >/dev/null 2>&1; then
  qrencode -t ANSIUTF8 "$phone_url" >&2
fi
