# shellcheck shell=bash
# lib-sg-mask.sh — server-guard.sh (規則 7/8) から分離した部品 (bdboard-qj0t): 引用符/
# ヒアドキュメントのマスク状態機械。単独では実行しない。server-guard.sh から `.` で読み込まれる。

# bdboard-kmh2: 上の分割はシェルの引用を理解しない素朴な文字列置換なので、引用符
# ('...' / "..." 。複数行にまたがるものを含む) の中にある ; & | や改行までセグメント境界
# として扱ってしまう (例: git commit -m "fix: guard; ..." のようにコミットメッセージの
# 引用符内に ; がある場合)。分割の前に、引用符の中身だけ ; & | と改行を空白に置き換えて
# 無害化する。引用符の外側や中身の他の文字は一切変えない — 分割の判定材料はそのまま残す
# (「言及しただけ」を deny する設計 (bdboard-wa48) 自体は変えない)。
#
# bdboard-qmum の opus レビュー (PR #767) で、最初の実装 (引用符を単純な状態機械で追う
# だけで、# コメント・$(...) やバッククォートの入れ子・閉じられない引用符の扱いが甘い版)
# には「無害化のつもりが本物の区切り文字まで隠してしまい、本来 deny すべき危険なコマンドを
# 見逃す」という新規の穴が複数見つかった (例: コメント中のアポストロフィで状態が狂う、
# $(...) の中の入れ子の引用符でずれる)。今の実装はそれを踏まえて安全側に倒し直したもの:
#
# 安全側の原則: 「確実に引用符の中だと判定できる場合だけ」区切り文字を無害化する。
# 判定に少しでも自信が持てない場合は、区切り文字を無害化せず残す (= 元の素朴な分割に
# 戻るだけで、誤検知が残る可能性はあっても見逃しにはならない)。
#
# 対応する範囲 (これ以上は「完全な shell パーサー」になるため対応しない):
#   - トップレベルの '...' と "..." の中身にある ; & | と改行を無害化する。
#   - # コメント (空白/行頭/;&|の直後などの語頭に現れたときだけ) は実改行まで丸ごと
#     読み飛ばし、中の引用符文字は一切解釈しない (bash 本体もコメント中は構文解析しない
#     ため、ここで引用符として数えると誤って状態がずれる — 過去の実装の穴の1つ)。
#   - $(...) とバッククォートは新しい入れ子として扱い、その中の引用符トグルが外側の
#     引用状態に漏れ出さないようにする。ただし $(...) 自身の中にある本物の ; & | と改行は
#     「無害化しない」(= 見える状態を保つ) — 元の素朴な分割がこれらを偶然にも区切りとして
#     捕まえていたのを壊さないため (bdboard-kmh2 の対象はあくまで「引用符の中の区切り文字」
#     で、$(...) の中身まで安全に解析する保証は無い)。
#   - ヒアドキュメント本体 (<<EOF / <<'EOF' / <<-EOF ... 対応する終端行まで) は bdboard-u4ne
#     (opus レビュー 2026-09-25, PR #790) 以降、専用の状態 (state h) で追跡し、区間内の
#     改行と ; & | を「引用符の中」と同様に無害化する。開始行の区切り文字 (<<・オプションの
#     `-`・区切り語の引用符有無) を検出してから終端行 (`-` 指定時は先頭タブを読み飛ばした上で
#     区切り語と完全一致する行。コマンド末尾で入力が尽きる場合も同様に終端とみなす) までを
#     1つの安全な区間として扱う。区切り語が数字だけで引用符も無い形 (`(( x << 2 ))` のような
#     算術左シフト) はヒアドキュメントと誤認しない。$(...) やバッククォートの入れ子と同様、
#     区間の終端が最後まで確定できない (入力が尽きても終端行が現れない) 場合は、無害化を
#     一切せず生のコマンドのまま返す (見逃しより誤検知)。
#   - $'...' (ANSI-C クォート) は専用の理解をしない。中身に応じて偶然に安全側 (下記の
#     「閉じられない/バランスしない場合は生のコマンドで判定」) に落ちる。
#   - 二重引用符内のバックスラッシュは、次の1文字を常にエスケープ (そのまま通す) と
#     みなす (`\"` に限らない — 限定すると `\\"` のような並びで閉じ引用符と誤認しうる)。
#   - 引用符の外側で `\'` / `\"` のようにバックスラッシュでエスケープされた引用符文字は
#     引用の開始とみなさない (誤ると、その後ろの本物の危険なコマンドを隠しかねない)。
#   - コマンド全体を走査し終えた時点で「トップレベルの引用/コメントが閉じている」かつ
#     「$(...) やバッククォートの入れ子がすべて閉じている」ことを確認する。どちらか一方
#     でも満たさなければ、無害化を一切せず**元の生のコマンドをそのまま返す** (= 分割は
#     完全に旧来の素朴な挙動に戻る。見逃しよりも誤検知が残る側に倒す)。
#   - 走査は文字ごとの状態機械で、大きな入力では bash の文字列連結コストにより遅くなる
#     (O(n^2))。hook 全体のタイムアウト (通常 10 秒) を超えないよう、コマンドが
#     SG_MASK_MAX_LEN 文字を超える場合は無害化を試みず生のコマンドをそのまま返す。
SG_MASK_MAX_LEN=3000

sg_mask_quoted_separators() {
  sg_mqs_s="$1"
  case "$sg_mqs_s" in
    *[\'\"]*) ;;
    *'<<'*) ;;
    *) printf '%s' "$sg_mqs_s"; return 0 ;;
  esac
  sg_mqs_len=${#sg_mqs_s}
  if [ "$sg_mqs_len" -gt "$SG_MASK_MAX_LEN" ]; then
    printf '%s' "$sg_mqs_s"
    return 0
  fi
  sg_mqs_out=''
  sg_mqs_state='n'
  sg_mqs_stack=''
  sg_mqs_saved=''
  sg_mqs_wordstart=1
  sg_mqs_i=0
  sg_mqs_heredoc_pending=''
  sg_mqs_heredoc_delim=''
  sg_mqs_heredoc_strip=''
  sg_mqs_h_line=''
  while [ "$sg_mqs_i" -lt "$sg_mqs_len" ]; do
    sg_mqs_c="${sg_mqs_s:sg_mqs_i:1}"
    sg_mqs_next=''
    if [ $((sg_mqs_i + 1)) -lt "$sg_mqs_len" ]; then
      sg_mqs_next="${sg_mqs_s:sg_mqs_i+1:1}"
    fi
    case "$sg_mqs_state" in
      c)
        # # コメント: 実改行まで無解釈で素通しする (引用符もトグルしない)。
        if [ "$sg_mqs_c" = "$SG_NL" ]; then
          sg_mqs_state='n'
        fi
        sg_mqs_out="$sg_mqs_out$sg_mqs_c"
        sg_mqs_i=$((sg_mqs_i + 1))
        case "$sg_mqs_c" in
          ' ' | '	' | "$SG_NL") sg_mqs_wordstart=1 ;;
          *) sg_mqs_wordstart=0 ;;
        esac
        continue
        ;;
      n)
        case "$sg_mqs_c" in
          \\)
            if [ -n "$sg_mqs_next" ]; then
              sg_mqs_out="$sg_mqs_out$sg_mqs_c$sg_mqs_next"
              sg_mqs_i=$((sg_mqs_i + 2))
              sg_mqs_wordstart=0
              continue
            fi
            ;;
          '#')
            if [ "$sg_mqs_wordstart" = 1 ]; then
              sg_mqs_state='c'
              sg_mqs_out="$sg_mqs_out$sg_mqs_c"
              sg_mqs_i=$((sg_mqs_i + 1))
              sg_mqs_wordstart=0
              continue
            fi
            ;;
          "'") sg_mqs_state="'" ;;
          '"') sg_mqs_state='"' ;;
          '$')
            if [ "$sg_mqs_next" = '(' ]; then
              sg_mqs_stack="${sg_mqs_stack}P"
              sg_mqs_saved="${sg_mqs_saved}n"
              sg_mqs_state='n'
              sg_mqs_out="$sg_mqs_out\$("
              sg_mqs_i=$((sg_mqs_i + 2))
              sg_mqs_wordstart=1
              continue
            fi
            ;;
          '`')
            sg_mqs_top=''
            if [ -n "$sg_mqs_stack" ]; then
              sg_mqs_slen=${#sg_mqs_stack}
              sg_mqs_top="${sg_mqs_stack:sg_mqs_slen-1:1}"
            fi
            if [ "$sg_mqs_top" = 'B' ]; then
              sg_mqs_slen=${#sg_mqs_stack}
              sg_mqs_state="${sg_mqs_saved:sg_mqs_slen-1:1}"
              sg_mqs_stack="${sg_mqs_stack:0:sg_mqs_slen-1}"
              sg_mqs_saved="${sg_mqs_saved:0:sg_mqs_slen-1}"
            else
              sg_mqs_stack="${sg_mqs_stack}B"
              sg_mqs_saved="${sg_mqs_saved}n"
              sg_mqs_state='n'
            fi
            sg_mqs_out="$sg_mqs_out$sg_mqs_c"
            sg_mqs_i=$((sg_mqs_i + 1))
            sg_mqs_wordstart=1
            continue
            ;;
          ')')
            sg_mqs_top=''
            if [ -n "$sg_mqs_stack" ]; then
              sg_mqs_slen=${#sg_mqs_stack}
              sg_mqs_top="${sg_mqs_stack:sg_mqs_slen-1:1}"
            fi
            if [ "$sg_mqs_top" = 'P' ]; then
              sg_mqs_slen=${#sg_mqs_stack}
              sg_mqs_state="${sg_mqs_saved:sg_mqs_slen-1:1}"
              sg_mqs_stack="${sg_mqs_stack:0:sg_mqs_slen-1}"
              sg_mqs_saved="${sg_mqs_saved:0:sg_mqs_slen-1}"
              sg_mqs_out="$sg_mqs_out$sg_mqs_c"
              sg_mqs_i=$((sg_mqs_i + 1))
              sg_mqs_wordstart=0
              continue
            fi
            ;;
        esac
        case "$sg_mqs_c" in
          '<')
            if [ -z "$sg_mqs_heredoc_pending" ] && [ "$sg_mqs_next" = '<' ]; then
              sg_mqs_h_after=''
              if [ $((sg_mqs_i + 2)) -lt "$sg_mqs_len" ]; then
                sg_mqs_h_after="${sg_mqs_s:sg_mqs_i+2:1}"
              fi
              if [ "$sg_mqs_h_after" != '<' ]; then
                sg_mqs_h_scan=$((sg_mqs_i + 2))
                sg_mqs_h_strip=''
                if [ "$sg_mqs_h_after" = '-' ]; then
                  sg_mqs_h_strip='yes'
                  sg_mqs_h_scan=$((sg_mqs_h_scan + 1))
                fi
                while [ "$sg_mqs_h_scan" -lt "$sg_mqs_len" ]; do
                  sg_mqs_h_ch="${sg_mqs_s:sg_mqs_h_scan:1}"
                  case "$sg_mqs_h_ch" in
                    ' ' | $'\t') sg_mqs_h_scan=$((sg_mqs_h_scan + 1)) ;;
                    *) break ;;
                  esac
                done
                sg_mqs_h_delim=''
                sg_mqs_h_quoted=''
                if [ "$sg_mqs_h_scan" -lt "$sg_mqs_len" ]; then
                  sg_mqs_h_open="${sg_mqs_s:sg_mqs_h_scan:1}"
                  case "$sg_mqs_h_open" in
                    "'" | '"')
                      sg_mqs_h_close_idx=-1
                      sg_mqs_h_j=$((sg_mqs_h_scan + 1))
                      while [ "$sg_mqs_h_j" -lt "$sg_mqs_len" ]; do
                        if [ "${sg_mqs_s:sg_mqs_h_j:1}" = "$sg_mqs_h_open" ]; then
                          sg_mqs_h_close_idx=$sg_mqs_h_j
                          break
                        fi
                        sg_mqs_h_j=$((sg_mqs_h_j + 1))
                      done
                      if [ "$sg_mqs_h_close_idx" -ge 0 ]; then
                        sg_mqs_h_delim="${sg_mqs_s:sg_mqs_h_scan+1:sg_mqs_h_close_idx-sg_mqs_h_scan-1}"
                        sg_mqs_h_scan=$((sg_mqs_h_close_idx + 1))
                        sg_mqs_h_quoted='yes'
                      fi
                      ;;
                    *)
                      sg_mqs_h_j=$sg_mqs_h_scan
                      while [ "$sg_mqs_h_j" -lt "$sg_mqs_len" ]; do
                        sg_mqs_h_ch="${sg_mqs_s:sg_mqs_h_j:1}"
                        case "$sg_mqs_h_ch" in
                          ' ' | $'\t' | "$SG_NL" | ';' | '&' | '|' | '<' | '>' | '(' | ')') break ;;
                        esac
                        sg_mqs_h_j=$((sg_mqs_h_j + 1))
                      done
                      if [ "$sg_mqs_h_j" -gt "$sg_mqs_h_scan" ]; then
                        sg_mqs_h_delim="${sg_mqs_s:sg_mqs_h_scan:sg_mqs_h_j-sg_mqs_h_scan}"
                        sg_mqs_h_scan=$sg_mqs_h_j
                      fi
                      ;;
                  esac
                fi
                # Unquoted numeric delimiters are arithmetic shifts, not heredocs.
                if [ -n "$sg_mqs_h_delim" ] && [ -z "$sg_mqs_h_quoted" ]; then
                  case "$sg_mqs_h_delim" in
                    *[!0-9]*) ;;
                    *) sg_mqs_h_delim='' ;;
                  esac
                fi
                if [ -n "$sg_mqs_h_delim" ]; then
                  sg_mqs_heredoc_pending='yes'
                  sg_mqs_heredoc_delim="$sg_mqs_h_delim"
                  sg_mqs_heredoc_strip="$sg_mqs_h_strip"
                  sg_mqs_out="$sg_mqs_out${sg_mqs_s:sg_mqs_i:sg_mqs_h_scan-sg_mqs_i}"
                  sg_mqs_i=$sg_mqs_h_scan
                  sg_mqs_wordstart=0
                  continue
                fi
              fi
            fi
            ;;
          "$SG_NL")
            if [ -n "$sg_mqs_heredoc_pending" ]; then
              sg_mqs_heredoc_pending=''
              sg_mqs_state='h'
              sg_mqs_h_line=''
              sg_mqs_c=' '
            fi
            ;;
        esac
        ;;
      h)
        sg_mqs_h_line="$sg_mqs_h_line$sg_mqs_c"
        case "$sg_mqs_c" in
          "$SG_NL")
            sg_mqs_h_check="${sg_mqs_h_line%"$SG_NL"}"
            if [ -n "$sg_mqs_heredoc_strip" ]; then
              while :; do
                case "$sg_mqs_h_check" in
                  $'\t'*) sg_mqs_h_check="${sg_mqs_h_check#?}" ;;
                  *) break ;;
                esac
              done
            fi
            sg_mqs_h_line=''
            if [ "$sg_mqs_h_check" = "$sg_mqs_heredoc_delim" ]; then
              # 終端行に一致: ヒアドキュメント本体を抜けるので、この実改行は
              # 「ヒアドキュメント終端直後に続く実コマンド」との本物の区切りとして
              # 残す (マスクしない)。ここで無条件に空白へ潰すと、終端直後の
              # `git checkout ...` 等が直前のコマンドと同じセグメントへ吸収され、
              # 規則 8 等のセグメント単位チェックから見えなくなる
              # (レビュー指摘: bdboard-u4ne PR #790 Blocker 1)。
              sg_mqs_state='n'
              sg_mqs_heredoc_delim=''
              sg_mqs_heredoc_strip=''
            else
              # 本体行の途中の実改行: 引き続き本体内なので従来どおりマスクする。
              sg_mqs_c=' '
            fi
            ;;
          ';' | '&' | '|' | '>' | '<') sg_mqs_c=' ' ;;
        esac
        ;;
      "'")
        case "$sg_mqs_c" in
          "'") sg_mqs_state='n' ;;
          ';' | '&' | '|' | '>' | '<') sg_mqs_c=' ' ;;
          "$SG_NL") sg_mqs_c=' ' ;;
        esac
        ;;
      '"')
        case "$sg_mqs_c" in
          \\)
            if [ -n "$sg_mqs_next" ]; then
              sg_mqs_out="$sg_mqs_out$sg_mqs_c$sg_mqs_next"
              sg_mqs_i=$((sg_mqs_i + 2))
              sg_mqs_wordstart=0
              continue
            fi
            ;;
          '"') sg_mqs_state='n' ;;
          '$')
            if [ "$sg_mqs_next" = '(' ]; then
              sg_mqs_stack="${sg_mqs_stack}P"
              sg_mqs_saved="${sg_mqs_saved}\""
              sg_mqs_state='n'
              sg_mqs_out="$sg_mqs_out\$("
              sg_mqs_i=$((sg_mqs_i + 2))
              sg_mqs_wordstart=1
              continue
            fi
            ;;
          '`')
            sg_mqs_stack="${sg_mqs_stack}B"
            sg_mqs_saved="${sg_mqs_saved}\""
            sg_mqs_state='n'
            sg_mqs_out="$sg_mqs_out$sg_mqs_c"
            sg_mqs_i=$((sg_mqs_i + 1))
            sg_mqs_wordstart=1
            continue
            ;;
          ';' | '&' | '|' | '>' | '<') sg_mqs_c=' ' ;;
          "$SG_NL") sg_mqs_c=' ' ;;
        esac
        ;;
    esac
    sg_mqs_out="$sg_mqs_out$sg_mqs_c"
    sg_mqs_i=$((sg_mqs_i + 1))
    case "$sg_mqs_c" in
      ' ' | '	' | "$SG_NL" | ';' | '&' | '|') sg_mqs_wordstart=1 ;;
      *) sg_mqs_wordstart=0 ;;
    esac
  done
  if [ "$sg_mqs_state" = 'h' ]; then
    sg_mqs_h_check="$sg_mqs_h_line"
    if [ -n "$sg_mqs_heredoc_strip" ]; then
      while :; do
        case "$sg_mqs_h_check" in
          $'\t'*) sg_mqs_h_check="${sg_mqs_h_check#?}" ;;
          *) break ;;
        esac
      done
    fi
    if [ "$sg_mqs_h_check" = "$sg_mqs_heredoc_delim" ]; then
      sg_mqs_state='n'
    fi
  fi
  if [ -n "$sg_mqs_stack" ]; then
    printf '%s' "$sg_mqs_s"
    return 0
  fi
  case "$sg_mqs_state" in
    n | c) printf '%s' "$sg_mqs_out" ;;
    *) printf '%s' "$sg_mqs_s" ;;
  esac
}
