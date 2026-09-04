#!/usr/bin/env bash
#
# bdboard-harness / bd heartbeat ループ同梱スクリプト (bdboard-0kql)。
#
# 各セッションが手書きした `while true; do bd heartbeat …; sleep …; done` は、
# チケット close 後やセッション終了後も生き残る「孤児ループ」になりうる。
# 孤児が lease を延命し続けると reclaim が永久に発火せず、「lease 生存＝作業中」
# という一次シグナルに偽陽性が注入される。
#
# 契約: `start` は自分でデタッチし、子ループが pidfile を書くまで有界待ちして return。
# デタッチした子は親と同じ bash 実装で起動する（$BASH）。呼び出し側が /bin/bash を選んだらループも /bin/bash で回る。
# `stop`/`status` は保持している PID への直接 kill のみ (pkill/killall 禁止)。状態は
# ${TMPDIR}/bd-heartbeat.<uid>/ 配下の 3 ファイル (pid / ids / log)。寿命は 3 重:
# (1) ID リストが空、(2) セッション PID 消失、(3) --max-hours 経過。
#
# 依存: bash(3.2 互換) / coreutils / bd と、任意で jq または python3 (show 失敗時の
# status 判定のみ。無ければ show 読取不能＝ fail-open で打ち続け、3 回連続失敗で脱落)。
set -uo pipefail
LC_ALL=C; export LC_ALL

SCRIPT_NAME="${0##*/}"

# 再 exec 用: bash <path> 呼び出しでも nohup 子が同じファイルを指すようにする
resolve_script_path() {
  case "$0" in
    /*) printf '%s' "$0" ;;
    *) (cd "$(dirname "$0")" && printf '%s/%s' "$(pwd)" "$(basename "$0")") ;;
  esac
}
SCRIPT_PATH="${BD_HEARTBEAT_SCRIPT:-$(resolve_script_path)}"

usage() {
  cat >&2 <<EOF
usage:
  bash $SCRIPT_NAME start --session-pid <pid> [--interval 90] [--max-hours 12] [--repo <path>] <id>...
  bash $SCRIPT_NAME stop   --session-pid <pid>
  bash $SCRIPT_NAME status --session-pid <pid>
EOF
}

validate_session_pid() {
  case "${1:-}" in
    ''|*[!0-9]*)
      usage
      exit 2
      ;;
  esac
}

state_uid() {
  id -u 2>/dev/null || printf '%s' 'unknown'
}

state_dir() {
  printf '%s/bd-heartbeat.%s' "${TMPDIR:-/tmp}" "$(state_uid)"
}

ensure_state_dir() {
  mkdir -p "$(state_dir)" 2>/dev/null || return 1
  chmod 700 "$(state_dir)" 2>/dev/null || true
}

pidfile_path() {
  printf '%s/%s.pid' "$(state_dir)" "$1"
}

idsfile_path() {
  printf '%s/%s.ids' "$(state_dir)" "$1"
}

logfile_path() {
  printf '%s/%s.log' "$(state_dir)" "$1"
}

utc_now() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

log_event() {
  # $1: session-pid / $2: message (no secrets)
  printf '%s %s\n' "$(utc_now)" "$2" >> "$(logfile_path "$1")"
}

is_pid_alive() {
  kill -0 "$1" 2>/dev/null
}

kill_pid_gracefully() {
  # $1: pid — 保持している PID への直接 kill のみ (負値・非数字は拒否)
  local pid="$1"
  case "$pid" in
    ''|*[!0-9]*)
      return 1
      ;;
  esac
  [ "$pid" -gt 1 ] || return 1
  if ! is_pid_alive "$pid"; then
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || true
  local i=0
  while [ "$i" -lt 20 ]; do
    if ! is_pid_alive "$pid"; then
      return 0
    fi
    sleep 0.1
    i=$((i + 1))
  done
  if is_pid_alive "$pid"; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

read_pidfile() {
  # $1: session-pid — stdout: pid or empty (第1フィールドのみ、数値検証付き)
  local pf line pid
  pf="$(pidfile_path "$1")"
  if [ ! -f "$pf" ]; then
    return 0
  fi
  IFS= read -r line < "$pf" || return 0
  pid="${line%%$'\t'*}"
  pid="$(printf '%s' "$pid" | tr -d '[:space:]')"
  case "$pid" in
    ''|*[!0-9]*)
      return 0
      ;;
  esac
  [ "$pid" -gt 1 ] || return 0
  printf '%s' "$pid"
}

read_pidfile_token() {
  # $1: session-pid — stdout: lstart token (第2フィールド) or empty
  local pf line token
  pf="$(pidfile_path "$1")"
  if [ ! -f "$pf" ]; then
    return 0
  fi
  IFS= read -r line < "$pf" || return 0
  case "$line" in
    *$'\t'*)
      token="${line#*$'\t'}"
      token="$(printf '%s' "$token" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      printf '%s' "$token"
      ;;
    *)
      return 0
      ;;
  esac
}

write_pidfile() {
  # $1: session-pid / $2: pid — "<pid><TAB><lstart>" 形式
  local lstart
  lstart="$(session_lstart "$2")"
  printf '%s\t%s\n' "$2" "$lstart" > "$(pidfile_path "$1")"
}

verify_loop_identity() {
  # $1: session-pid / $2: loop pid — 全条件を満たすときだけ 0
  local session_pid="$1" pid="$2" saved_token current_lstart cmdline
  case "$pid" in
    ''|*[!0-9]*)
      return 1
      ;;
  esac
  [ "$pid" -gt 1 ] || return 1
  if ! is_pid_alive "$pid"; then
    return 1
  fi
  saved_token="$(read_pidfile_token "$session_pid")"
  if [ -z "$saved_token" ]; then
    return 1
  fi
  current_lstart="$(session_lstart "$pid")"
  if [ -z "$current_lstart" ] || [ "$current_lstart" != "$saved_token" ]; then
    return 1
  fi
  cmdline="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
  case "$cmdline" in
    *bd-heartbeat*)
      return 0
      ;;
  esac
  return 1
}

write_idsfile() {
  # $1: session-pid / remaining ids as "$2" "$3" ...
  local spid="$1"
  shift
  local idsfile
  idsfile="$(idsfile_path "$spid")"
  : > "$idsfile"
  while [ "$#" -gt 0 ]; do
    printf '%s\n' "$1" >> "$idsfile"
    shift
  done
}

read_idsfile() {
  # $1: session-pid — populates global ids[] array
  ids=()
  local idsfile line
  idsfile="$(idsfile_path "$1")"
  if [ ! -f "$idsfile" ]; then
    return 0
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    ids[${#ids[@]}]="$line"
  done < "$idsfile"
}

session_lstart() {
  ps -o lstart= -p "$1" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

float_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN { exit (a + 0 >= b + 0) ? 0 : 1 }'
}

JSON_TOOL=''
if command -v jq >/dev/null 2>&1; then
  JSON_TOOL='jq'
elif command -v python3 >/dev/null 2>&1; then
  JSON_TOOL='python3'
fi

json_status() {
  # $1: JSON text — stdout: status field or empty
  case "$JSON_TOOL" in
    jq)
      printf '%s' "$1" | jq -r '
        (if type == "array" then (.[0] // {}) else . end)
        | .status // empty
      ' 2>/dev/null
      ;;
    python3)
      printf '%s' "$1" | python3 -c '
import json, sys
try:
    cur = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if isinstance(cur, list):
    cur = cur[0] if cur else {}
if isinstance(cur, dict):
    st = cur.get("status")
    if isinstance(st, str):
        sys.stdout.write(st)
' 2>/dev/null
      ;;
    *)
      return 1
      ;;
  esac
}

remove_id_at_index() {
  # $1: index — rebuilds ids[], fail_counts[], owner_fail_counts[]
  local idx="$1" new_ids=() new_fails=() new_owner_fails=() i=0
  while [ "$i" -lt "${#ids[@]}" ]; do
    if [ "$i" -ne "$idx" ]; then
      new_ids[${#new_ids[@]}]="${ids[$i]}"
      new_fails[${#new_fails[@]}]="${fail_counts[$i]:-0}"
      new_owner_fails[${#new_owner_fails[@]}]="${owner_fail_counts[$i]:-0}"
    fi
    i=$((i + 1))
  done
  ids=("${new_ids[@]+"${new_ids[@]}"}")
  fail_counts=("${new_fails[@]+"${new_fails[@]}"}")
  owner_fail_counts=("${new_owner_fails[@]+"${new_owner_fails[@]}"}")
}

run_heartbeat_loop() {
  local session_pid="$1" interval="$2" max_hours="$3" repo="$4"
  local session_lstart_baseline loop_pid idsfile
  local start_epoch elapsed_hours

  ensure_state_dir || {
    log_event "$session_pid" "exit reason=state-dir-unavailable"
    exit 1
  }

  session_lstart_baseline="$(session_lstart "$session_pid")"
  if [ -z "$session_lstart_baseline" ]; then
    log_event "$session_pid" "exit reason=session-lstart-unavailable"
    rm -f "$(pidfile_path "$session_pid")" "$(idsfile_path "$session_pid")"
    exit 0
  fi

  read_idsfile "$session_pid"
  if [ "${#ids[@]}" -eq 0 ]; then
    log_event "$session_pid" "exit reason=no-ids"
    rm -f "$(pidfile_path "$session_pid")" "$(idsfile_path "$session_pid")"
    exit 0
  fi

  loop_pid=$$
  if [ "${#ids[@]}" -eq 0 ]; then
    ids_csv=''
  else
    ids_csv="$(IFS=,; printf '%s' "${ids[*]}")"
  fi
  log_event "$session_pid" "start session-pid=${session_pid} interval=${interval} max-hours=${max_hours} repo=${repo} ids=${ids_csv}"

  write_pidfile "$session_pid" "$loop_pid"

  # bash 3.2: シグナルで pidfile/ids を掃除 (自分の pidfile のときだけ)
  _loop_trap() {
    pf_pid="$(read_pidfile "$session_pid")"
    if [ "$pf_pid" = "$loop_pid" ]; then
      rm -f "$(pidfile_path "$session_pid")" "$(idsfile_path "$session_pid")"
    fi
    log_event "$session_pid" "exit reason=signal"
    exit 0
  }
  trap '_loop_trap' TERM INT HUP

  fail_counts=()
  owner_fail_counts=()
  i=0
  while [ "$i" -lt "${#ids[@]}" ]; do
    fail_counts[$i]=0
    owner_fail_counts[$i]=0
    i=$((i + 1))
  done

  start_epoch=$(date +%s)

  while :; do
    # --- session survival ---
    if ! is_pid_alive "$session_pid"; then
      log_event "$session_pid" "exit reason=session-gone"
      break
    fi
    current_lstart="$(session_lstart "$session_pid")"
    if [ -z "$current_lstart" ] || [ "$current_lstart" != "$session_lstart_baseline" ]; then
      log_event "$session_pid" "exit reason=session-pid-reused"
      break
    fi
    pf_pid="$(read_pidfile "$session_pid")"
    if [ -n "$pf_pid" ]; then
      if [ "$pf_pid" != "$loop_pid" ]; then
        log_event "$session_pid" "exit reason=replaced"
        # Do not rm pidfile/ids: the replacing loop owns those files.
        break
      fi
    else
      log_event "$session_pid" "exit reason=replaced"
      # Do not rm pidfile/ids: the replacing loop owns those files.
      break
    fi

    # --- max-hours belt ---
    now_epoch=$(date +%s)
    elapsed_hours=$(awk -v s="$start_epoch" -v n="$now_epoch" 'BEGIN { printf "%.6f", (n - s) / 3600 }')
    if float_ge "$elapsed_hours" "$max_hours"; then
      log_event "$session_pid" "exit reason=max-hours"
      break
    fi

    if [ "${#ids[@]}" -eq 0 ]; then
      log_event "$session_pid" "exit reason=no-ids"
      break
    fi

    # --- heartbeat each id sequentially ---
    i=0
    while [ "$i" -lt "${#ids[@]}" ]; do
      id="${ids[$i]}"
      if bd -C "$repo" heartbeat "$id" >/dev/null 2>&1; then
        log_event "$session_pid" "beat id=${id} ok"
        fail_counts[$i]=0
        owner_fail_counts[$i]=0
      else
        log_event "$session_pid" "beat id=${id} failed"
        show_json=""
        show_rc=0
        show_json="$(bd -C "$repo" show "$id" --json 2>/dev/null)" || show_rc=$?

        drop_id=0
        if [ "$show_rc" -ne 0 ] || [ -z "$show_json" ]; then
          fail_counts[$i]=$((fail_counts[$i] + 1))
          consec="${fail_counts[$i]}"
          if [ "$consec" -ge 3 ]; then
            log_event "$session_pid" "drop id=${id} reason=show-failed-3x"
            drop_id=1
          else
            log_event "$session_pid" "show-failed id=${id} consecutive=${consec} keeping"
          fi
        else
          st="$(json_status "$show_json" || true)"
          if [ -z "$st" ]; then
            fail_counts[$i]=$((fail_counts[$i] + 1))
            consec="${fail_counts[$i]}"
            if [ "$consec" -ge 3 ]; then
              log_event "$session_pid" "drop id=${id} reason=show-failed-3x"
              drop_id=1
            else
              log_event "$session_pid" "show-failed id=${id} consecutive=${consec} keeping"
            fi
          elif [ "$st" != "in_progress" ]; then
            log_event "$session_pid" "drop id=${id} reason=not-in-progress status=${st}"
            drop_id=1
          else
            # status=in_progress でも heartbeat 失敗は所有権喪失の可能性 — show 成功で fail_counts はリセットしない
            fail_counts[$i]=0
            owner_fail_counts[$i]=$((owner_fail_counts[$i] + 1))
            consec="${owner_fail_counts[$i]}"
            # 3 failures × interval (>90s) > 5min lease TTL — lease is dead by then anyway
            if [ "$consec" -ge 3 ]; then
              log_event "$session_pid" "drop id=${id} reason=heartbeat-failed-3x"
              drop_id=1
            else
              log_event "$session_pid" "heartbeat-failed id=${id} consecutive=${consec} keeping"
            fi
          fi
        fi

        if [ "$drop_id" -eq 1 ]; then
          remove_id_at_index "$i"
          write_idsfile "$session_pid" "${ids[@]+"${ids[@]}"}"
          continue
        fi
      fi
      i=$((i + 1))
    done

    sleep "$interval"
  done

  pf_pid="$(read_pidfile "$session_pid")"
  if [ "$pf_pid" = "$loop_pid" ]; then
    rm -f "$(pidfile_path "$session_pid")" "$(idsfile_path "$session_pid")"
  fi
  exit 0
}

cmd_start() {
  local session_pid='' interval='90' max_hours='12' repo='.'
  local ids=()

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --session-pid)
        [ "$#" -lt 2 ] && { usage; exit 2; }
        session_pid="$2"
        shift 2
        ;;
      --interval)
        [ "$#" -lt 2 ] && { usage; exit 2; }
        interval="$2"
        shift 2
        ;;
      --max-hours)
        [ "$#" -lt 2 ] && { usage; exit 2; }
        max_hours="$2"
        shift 2
        ;;
      --repo)
        [ "$#" -lt 2 ] && { usage; exit 2; }
        repo="$2"
        shift 2
        ;;
      --)
        shift
        break
        ;;
      -*)
        usage
        exit 2
        ;;
      *)
        ids[${#ids[@]}]="$1"
        shift
        ;;
    esac
  done

  while [ "$#" -gt 0 ]; do
    ids[${#ids[@]}]="$1"
    shift
  done

  validate_session_pid "$session_pid"

  case "$interval" in
    ''|*[!0-9.]*|.*)
      usage
      exit 2
      ;;
  esac
  float_ge "$interval" "0.05" || {
    usage
    exit 2
  }
  case "$max_hours" in
    ''|*[!0-9.]*)
      usage
      exit 2
      ;;
  esac
  float_ge "$max_hours" "0.0000001" || {
    usage
    exit 2
  }

  if [ "${#ids[@]}" -eq 0 ]; then
    usage
    exit 2
  fi

  if [ "${BD_HEARTBEAT_DETACHED:-}" = "1" ]; then
    run_heartbeat_loop "$session_pid" "$interval" "$max_hours" "$repo"
    exit 0
  fi

  ensure_state_dir || {
    printf '%s\n' "bd-heartbeat: cannot create state directory" >&2
    exit 1
  }

  old_pid="$(read_pidfile "$session_pid")"
  if [ -n "$old_pid" ]; then
    if verify_loop_identity "$session_pid" "$old_pid"; then
      kill_pid_gracefully "$old_pid"
      log_event "$session_pid" "replaced old-loop-pid=${old_pid}"
    else
      log_event "$session_pid" "stale-pidfile discarded pid=${old_pid}"
      rm -f "$(pidfile_path "$session_pid")" "$(idsfile_path "$session_pid")"
    fi
  fi

  write_idsfile "$session_pid" "${ids[@]+"${ids[@]}"}"

  rm -f "$(pidfile_path "$session_pid")"

  # 自分でデタッチ: 呼び出し側に & / nohup を書かせない
  nohup env BD_HEARTBEAT_DETACHED=1 BD_HEARTBEAT_SCRIPT="$SCRIPT_PATH" "${BASH:-bash}" "$SCRIPT_PATH" start \
    --session-pid "$session_pid" \
    --interval "$interval" \
    --max-hours "$max_hours" \
    --repo "$repo" \
    "${ids[@]+"${ids[@]}"}" \
    >/dev/null 2>&1 &
  child_pid=$!

  i=0
  while [ "$i" -lt 100 ]; do
    new_pid="$(read_pidfile "$session_pid")"
    if [ -n "$new_pid" ] && is_pid_alive "$new_pid"; then
      exit 0
    fi
    sleep 0.05
    i=$((i + 1))
  done

  printf '%s\n' "bd-heartbeat: loop did not register pidfile within 5s (session-pid=${session_pid})" >&2
  kill_pid_gracefully "$child_pid"
  rm -f "$(pidfile_path "$session_pid")" "$(idsfile_path "$session_pid")"
  exit 1
}

cmd_stop() {
  local session_pid=''

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --session-pid)
        [ "$#" -lt 2 ] && { usage; exit 2; }
        session_pid="$2"
        shift 2
        ;;
      -*)
        usage
        exit 2
        ;;
      *)
        usage
        exit 2
        ;;
    esac
  done

  validate_session_pid "$session_pid"

  ensure_state_dir || {
    printf '%s\n' "bd-heartbeat: cannot access state directory" >&2
    exit 1
  }

  old_pid="$(read_pidfile "$session_pid")"
  if [ -n "$old_pid" ]; then
    if verify_loop_identity "$session_pid" "$old_pid"; then
      kill_pid_gracefully "$old_pid"
      log_event "$session_pid" "stop"
    else
      log_event "$session_pid" "stale-pidfile discarded pid=${old_pid}"
    fi
  else
    printf '%s\n' 'not running'
  fi

  rm -f "$(pidfile_path "$session_pid")" "$(idsfile_path "$session_pid")"
  exit 0
}

cmd_status() {
  local session_pid=''

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --session-pid)
        [ "$#" -lt 2 ] && { usage; exit 2; }
        session_pid="$2"
        shift 2
        ;;
      -*)
        usage
        exit 2
        ;;
      *)
        usage
        exit 2
        ;;
    esac
  done

  validate_session_pid "$session_pid"

  ensure_state_dir || {
    printf '%s\n' 'stopped'
    exit 1
  }

  loop_pid="$(read_pidfile "$session_pid")"
  if [ -z "$loop_pid" ]; then
    printf '%s\n' 'stopped'
    exit 1
  fi

  read_idsfile "$session_pid"
  if [ "${#ids[@]}" -eq 0 ]; then
    ids_csv=''
  else
    ids_csv="$(IFS=,; printf '%s' "${ids[*]}")"
  fi

  if verify_loop_identity "$session_pid" "$loop_pid"; then
    printf 'running pid=%s ids=%s\n' "$loop_pid" "$ids_csv"
    exit 0
  fi

  printf 'stale pid=%s\n' "$loop_pid"
  exit 1
}

# --- main ---
if [ "$#" -lt 1 ]; then
  usage
  exit 2
fi

subcmd="$1"
shift

case "$subcmd" in
  start) cmd_start "$@" ;;
  stop) cmd_stop "$@" ;;
  status) cmd_status "$@" ;;
  *)
    usage
    exit 2
    ;;
esac
