# shellcheck shell=bash
# lib-sg-git.sh — server-guard.sh (規則 7/8) から分離した部品 (bdboard-qj0t): git token 判定 (main checkout の working
# tree/HEAD を変える git サブコマンドの検知)。単独では実行しない。server-guard.sh から `.` で読み込まれる。

# --- 規則 8: main checkout の working tree/HEAD を変える git サブコマンド (bdboard-kxqb)。
# sg_deny_sub (規則 7 用) とはメッセージの趣旨が違う (常時稼働サーバーの再配備ではなく
# 「議長の作業ツリーを壊す」ことが理由) ので、専用の deny 文言を持つ。
sg_deny_git_mutate() {
  sg_audit "8-git-$1"
  deny \
    "bdboard-harness: サブエージェントは main checkout ($SG_MAIN) で git $1 を実行できません (working tree/HEAD を変更するため)。" \
    "worktree で作業してください: cd <worktree> && git $1 ... か git -C <worktree> $1 ... を使ってください。" \
    "worktree が無ければ: git -C $SG_MAIN worktree add .claude/worktrees/<id> -b bd/<id> origin/main"
}

# 引数: 実効 dir, サブコマンド名。サブエージェントかつ main checkout なら deny。
# alwaysOnServer の有無 (SG_PORT) に関係なく有効 — main checkout の working tree/HEAD
# 保護は常時稼働サーバーとは独立の理由による。
sg_check_main_git_mutate() {
  [ -n "$SG_IS_SUB" ] || return 0
  sg_dir_is_main "$1" || return 0
  sg_deny_git_mutate "$2"
}

# 引数: 実効 dir, 同一セグメントの GIT_DIR/GIT_WORK_TREE 上書き有無, git 以降の引数列。
# 通常の git dispatch とパイプ後の git dispatch が同じ -C / subcommand 判定を共有する。
sg_handle_git_tokens() {
  local sg_git_dir="$1"
  local sg_git_env_override="$2"
  local sg_c_saved_dir=''
  local sg_git_dir_unresolved=''
  local sg_git_dir_value=''
  local sg_git_subcommand=''
  shift 2

  [ $# -gt 0 ] || return 0
  case "$1" in \\*) set -- "${1#\\}" "${@:2}" ;; esac
  [ "${1##*/}" = 'git' ] || return 0
  shift

  while [ $# -gt 0 ]; do
    case "$1" in
      -C)
        # 複数の -C は本物の git と同じく「直前の -C からの相対」で連鎖させる
        # (bdboard-9882): sg_resolve_dir は $SG_DIR を基準に解決するので、
        # 一時的に $SG_DIR を直前の sg_git_dir に差し替えてから呼ぶ。
        sg_c_saved_dir="$SG_DIR"
        SG_DIR="$sg_git_dir"
        sg_git_dir_value="$(sg_expand "${2:-}")"
        case "$sg_git_dir_value" in
          *'$('* | *'`'* | *'$'*) sg_git_dir_unresolved='yes' ;;
        esac
        sg_git_dir="$(sg_resolve_dir "${2:-}")"
        SG_DIR="$sg_c_saved_dir"
        shift
        [ $# -gt 0 ] && shift
        ;;
      -c | --git-dir | --work-tree | --namespace)
        shift
        [ $# -gt 0 ] && shift
        ;;
      -*) shift ;;
      *) break ;;
    esac
  done

  sg_git_subcommand="${1:-}"
  case "$sg_git_subcommand" in
    pull)
      # 規則 7a (alwaysOnServer.port 前提、サーバー再配備文脈の専用メッセージ) はそのまま維持。
      if [ -n "$SG_PORT" ]; then
        sg_check_main_action "$sg_git_dir" '7a-git-pull' 'git pull'
      fi
      # bdboard-rj7y (2026-09-26): 7a とは独立に、port の有無に関係なく規則 8 でも pull を
      # working tree/HEAD 変更系として塞ぐ。alwaysOnServer.port を宣言しないパック配布先で
      # 7a だけでは fail-open だった穴を閉じる。port ありの契約では上の 7a が先に deny して
      # exit するので、ここまで到達した時点で「7a は通った (= main checkout ではないか議長)」
      # ことが確定しており、二重の deny メッセージにはならない。
      if [ -n "$SG_IS_SUB" ] && { [ -n "$sg_git_dir_unresolved" ] || [ -n "$sg_git_env_override" ]; }; then
        sg_deny_git_mutate 'pull'
      fi
      sg_check_main_git_mutate "$sg_git_dir" 'pull'
      ;;
    checkout | switch | commit | reset | merge | rebase | stash | restore | cherry-pick | revert | am | clean | bisect | apply | rm | mv)
      if [ -n "$SG_IS_SUB" ] && { [ -n "$sg_git_dir_unresolved" ] || [ -n "$sg_git_env_override" ]; }; then
        sg_deny_git_mutate "$sg_git_subcommand"
      fi
      sg_check_main_git_mutate "$sg_git_dir" "$sg_git_subcommand"
      ;;
  esac
}

# 引用符の外にある実パイプの直後のコマンド語だけを見る。引用符内の `git` 言及は無視する。
sg_check_pipe_git() {
  local sg_pipe_raw="$1"
  local sg_pipe_dir="$2"
  local sg_pipe_env_override="$3"
  local sg_pipe_len=${#1}
  local sg_pipe_i=0
  local sg_pipe_j=0
  local sg_pipe_start=0
  local sg_pipe_single=''
  local sg_pipe_double=''
  local sg_pipe_token_single=''
  local sg_pipe_token_double=''
  local sg_pipe_pending=''
  local sg_pipe_char=''
  local sg_pipe_token=''
  local sg_pipe_clean=''
  local sg_pipe_rest=''

  while [ "$sg_pipe_i" -lt "$sg_pipe_len" ]; do
    sg_pipe_char="${sg_pipe_raw:$sg_pipe_i:1}"

    if [ -n "$sg_pipe_single" ]; then
      [ "$sg_pipe_char" = "'" ] && sg_pipe_single=''
      sg_pipe_i=$((sg_pipe_i + 1))
      continue
    fi
    if [ -n "$sg_pipe_double" ]; then
      [ "$sg_pipe_char" = '"' ] && sg_pipe_double=''
      sg_pipe_i=$((sg_pipe_i + 1))
      continue
    fi

    case "$sg_pipe_char" in
      "'") sg_pipe_single='yes' ;;
      '"') sg_pipe_double='yes' ;;
      '|') sg_pipe_pending='yes' ;;
      [[:space:]]) ;;
      *)
        if [ -n "$sg_pipe_pending" ]; then
          sg_pipe_start=$sg_pipe_i
          sg_pipe_j=$sg_pipe_i
          sg_pipe_token_single=''
          sg_pipe_token_double=''
          while [ "$sg_pipe_j" -lt "$sg_pipe_len" ]; do
            sg_pipe_char="${sg_pipe_raw:$sg_pipe_j:1}"
            if [ -n "$sg_pipe_token_single" ]; then
              [ "$sg_pipe_char" = "'" ] && sg_pipe_token_single=''
            elif [ -n "$sg_pipe_token_double" ]; then
              [ "$sg_pipe_char" = '"' ] && sg_pipe_token_double=''
            else
              case "$sg_pipe_char" in
                "'") sg_pipe_token_single='yes' ;;
                '"') sg_pipe_token_double='yes' ;;
                '|' | [[:space:]]) break ;;
              esac
            fi
            sg_pipe_j=$((sg_pipe_j + 1))
          done

          sg_pipe_token="${sg_pipe_raw:$sg_pipe_start:$((sg_pipe_j - sg_pipe_start))}"
          sg_pipe_clean="$(printf '%s' "$sg_pipe_token" | tr -d '"'"'"')')"
          case "$sg_pipe_clean" in \\*) sg_pipe_clean="${sg_pipe_clean#\\}" ;; esac
          if [ "${sg_pipe_clean##*/}" = 'git' ]; then
            sg_pipe_rest="${sg_pipe_raw:$sg_pipe_start}"
            sg_pipe_clean="$(printf '%s' "$sg_pipe_rest" | tr -d '"'"'"')')"
            # shellcheck disable=SC2086
            set -- $sg_pipe_clean
            sg_handle_git_tokens "$sg_pipe_dir" "$sg_pipe_env_override" "$@"
          fi

          sg_pipe_pending=''
          sg_pipe_i=$sg_pipe_j
          continue
        fi
        ;;
    esac
    sg_pipe_i=$((sg_pipe_i + 1))
  done
}
