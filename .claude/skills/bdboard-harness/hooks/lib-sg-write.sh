# shellcheck shell=bash
# lib-sg-write.sh — server-guard.sh (規則 7/8) から分離した部品 (bdboard-qj0t): git 以外の書き込み系コマンド
# (sed -i/cp/mv/tee/npm install/aimix) の main checkout 対象検知。単独では実行しない。server-guard.sh から `.` で読み込まれる。

# --- bdboard-1zrs: git 以外の書き込み系コマンド (sed -i / cp / mv / tee / リダイレクト /
# npm install) と、委譲ツール (aimix) の main checkout での起動を塞ぐ。sg_deny_sub
# (規則7用、サーバー再配備の文言) / sg_deny_git_mutate (git専用の文言) とは別に、
# コマンド非依存の汎用文言を持つ。
sg_deny_main_write() {
  sg_audit "8-write-$1"
  deny \
    "bdboard-harness: サブエージェントは main checkout ($SG_MAIN) で $2 を実行できません (working tree を直接変更するため)。" \
    'worktree で作業してください: cd <worktree> && ... のように per-ticket worktree に向けてください。' \
    "worktree が無ければ: git -C $SG_MAIN worktree add .claude/worktrees/<id> -b bd/<id> origin/main"
}

# 引数: 実効 dir, ラベル, 説明。サブエージェントかつ main checkout なら deny。
sg_check_main_write() {
  [ -n "$SG_IS_SUB" ] || return 0
  sg_dir_is_main_or_git_internal "$1" || return 0
  sg_deny_main_write "$2" "$3"
}

# 生パストークン (相対/絶対/~、sg_expand 前) の「親ディレクトリ」を実効 dir 基準で
# 解決する。sg_resolve_dir はディレクトリ専用 (cd できる前提) なので、まだ存在しない
# ファイルを書き込み先に取るコマンド (sed -i の対象、リダイレクト先、cp/mv/tee の宛先)
# には使えない。トークンを展開してから最後の `/` で分割し、ディレクトリ側だけを既存の
# 絶対/相対解決ルールに通す (スラッシュが無ければ実効 dir そのもの)。
# sg_resolve_target_dir の本体。「展開済みの生パス文字列」を直接受け取る版 — 呼び出し元が
# 展開後に何らかの前処理 (bdboard-1zrs round3: $VAR 未解決部分の切り詰めなど) をしてから
# 渡したいケースのために分離してある。
sg_resolve_target_dir_expanded() {
  sg_rtd_expanded="$1"
  case "$sg_rtd_expanded" in
    /*) sg_rtd_abs="$sg_rtd_expanded" ;;
    *) sg_rtd_abs="$SG_DIR/$sg_rtd_expanded" ;;
  esac
  if [ -d "$sg_rtd_abs" ]; then
    sg_canon "$sg_rtd_abs"
    return 0
  fi
  case "$sg_rtd_expanded" in
    */*)
      sg_rtd_dir="${sg_rtd_expanded%/*}"
      [ -n "$sg_rtd_dir" ] || sg_rtd_dir='/'
      ;;
    *) sg_rtd_dir='' ;;
  esac
  case "$sg_rtd_dir" in
    '') printf '%s' "$SG_DIR" ;;
    /*) sg_canon "$sg_rtd_dir" ;;
    *) sg_canon "$SG_DIR/$sg_rtd_dir" ;;
  esac
}

sg_resolve_target_dir() {
  sg_resolve_target_dir_expanded "$(sg_expand "$1")"
}

# 引数: ラベル, 説明, 以降チェック対象のパストークン列 (可変長)。サブエージェントかつ
# main checkout ならその中の最初にマッチしたトークンで deny する。
sg_check_main_write_targets() {
  [ -n "$SG_IS_SUB" ] || return 0
  sg_cmwt_label="$1"
  sg_cmwt_desc="$2"
  shift 2
  for sg_cmwt_tok in "$@"; do
    [ -n "$sg_cmwt_tok" ] || continue
    sg_cmwt_expanded="$(sg_expand "$sg_cmwt_tok")"
    case "$sg_cmwt_expanded" in
      # 展開後も先頭が $ (= 何も分からない完全に未解決な変数参照) なら判定不能として
      # 見逃す (fail-open)。先頭以外に $ がある場合は、その手前までは既知のパスなので
      # 切り詰めて判定する (bdboard-1zrs round3 独立レビュー: 旧実装は文字列中の
      # どこかに $ が1つでもあれば丸ごとスキップしていたため、
      # `$MAIN/src/out-$$.txt` のように既知のディレクトリ + 未追跡変数 ($$ など) の
      # 組み合わせを誤って見逃していた)。
      '$'*) continue ;;
      *'$'*) sg_cmwt_expanded="${sg_cmwt_expanded%%\$*}" ;;
    esac
    [ -n "$sg_cmwt_expanded" ] || continue
    sg_cmwt_dir="$(sg_resolve_target_dir_expanded "$sg_cmwt_expanded")"
    if sg_dir_is_main_or_git_internal "$sg_cmwt_dir"; then
      sg_deny_main_write "$sg_cmwt_label" "$sg_cmwt_desc"
    fi
  done
}

# 引数: トークン1つ。「パイプ/コマンド区切り」なら真 — cp/mv/sed/tee の対象引数
# スキャンをここで完全に打ち切ってよい、本当にシェル構文の境界であり、これ以降の
# トークンはこのコマンドの引数ではないため。
# (bdboard-1zrs round3 独立レビュー: round2 の sg_is_pipe_or_redirect_tok はリダイレクト
# 演算子もここに含めて break していたため、宛先より前に `2>/dev/null` 等の単発
# リダイレクトが来ただけで本当の宛先を見逃して誤って許可していた。リダイレクトは
# 「打ち切り」ではなく「読み飛ばして継続」が正しい — 下の2関数を参照。)
sg_is_scan_stop_tok() {
  case "$1" in
    '|' | '||' | '&&' | ';' | '&') return 0 ;;
    *) return 1 ;;
  esac
}

# 引数: トークン1つ。単発のリダイレクト演算子 (それ自身、または前置き融合形:
# >, >>, 1>, 2>, &>, 1>>, 2>>, &>>, <, <<, <<-, <<< やそれに宛先/デリミタが
# 融合した形) なら真。これらは「シェル構文だが、この先にコマンド引数が続く
# 可能性がある」ため、対象引数スキャンは打ち切らずに読み飛ばして継続する
# (`tee >/dev/null $MAIN/f` や `tee <<EOF $MAIN/f` のように宛先より前に現れても、
# 宛先を見逃してはならない)。
sg_is_skippable_redirect_tok() {
  case "$1" in
    '&>>'* | '&>'* | '1>>'* | '1>'* | '2>>'* | '2>'* | '>>'* | '>'* | '<'*)
      return 0
      ;;
    *) return 1 ;;
  esac
}

# 引数: トークン1つ。sg_is_skippable_redirect_tok が真だったトークンについて、
# 「これ自身に宛先/デリミタが融合していない ("裸" の演算子) ため、次のトークンも
# 合わせて読み飛ばすべきか」を判定する (裸なら真、`>file` のような融合形なら偽)。
sg_redirect_tok_needs_next() {
  case "$1" in
    '>' | '>>' | '1>' | '1>>' | '2>' | '2>>' | '&>' | '&>>' | '<' | '<<' | '<<-' | '<<<')
      return 0
      ;;
    *) return 1 ;;
  esac
}

# sed の単一ダッシュ短縮オプション束 ("-Ees/a/b/" 等) を1文字ずつ解析する。
# 呼び出し元のグローバル sg_sed_has_i / sg_sed_saw_script を必要に応じて立てる。
# e/f/l を見つけたら、その位置以降の残り文字列をそのオプションの引数とみなし
# (空なら「次のトークンが引数」を意味する sg_sgf_consumed_next=yes を立てて)
# この束の走査を打ち切る (GNU sed はこれらの引数を「同一トークン内の残り」か
# 「次のトークン」のどちらかとしてのみ扱い、その後ろへさらに短縮フラグを
# 束ねることはできないため)。i/I (in-place) も同様に残りを消費して打ち切るが、
# 引数を次のトークンから取ることはしない (BSD sed は -i に対し常に次のトークンを
# サフィックスとして要求するが、静的にそれを断定すると本当の対象/スクリプトを
# 誤って呑み込みかねないため、より安全側 = 過検知はあっても見逃しにはならない側
# に倒している。sg_sed_has_i さえ立っていれば、後続で見つかる本当の書き込み対象は
# 引き続き検知される)。
sg_sed_parse_flag_group() {
  sg_sgf_body="${1#-}"
  sg_sgf_consumed_next=''
  sg_sgf_len=${#sg_sgf_body}
  sg_sgf_k=0
  while [ "$sg_sgf_k" -lt "$sg_sgf_len" ]; do
    sg_sgf_c="${sg_sgf_body:sg_sgf_k:1}"
    case "$sg_sgf_c" in
      i | I)
        sg_sed_has_i='yes'
        sg_sgf_k=$sg_sgf_len
        ;;
      e | f)
        sg_sed_saw_script='yes'
        sg_sgf_rest="${sg_sgf_body:$((sg_sgf_k + 1))}"
        [ -n "$sg_sgf_rest" ] || sg_sgf_consumed_next='yes'
        sg_sgf_k=$sg_sgf_len
        ;;
      l)
        sg_sgf_rest="${sg_sgf_body:$((sg_sgf_k + 1))}"
        [ -n "$sg_sgf_rest" ] || sg_sgf_consumed_next='yes'
        sg_sgf_k=$sg_sgf_len
        ;;
      *)
        sg_sgf_k=$((sg_sgf_k + 1))
        ;;
    esac
  done
}
