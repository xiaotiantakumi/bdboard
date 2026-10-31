#!/usr/bin/env python3
"""確認チケットの本文を共通の見出し順で組み立て、bd で作成/更新する (bdboard-efw5)。

動画の確認チケットの共通処理だけを持つ。見る対象のパスや見るポイントは JSON (--spec) で
渡す。プロジェクト固有の場所や名前は持たない。

見出しの順番 (無い節は出さない):
  ## 今回見てほしいもの  (通しの動画 / 直した箇所の確認動画 / 耳で確かめる確認動画 /
                          見るポイント / 判断してほしいこと)
  ## 直したところ
  ## 耳で聞いてほしいところ
  ## 資料
  ## そのほか

spec JSON のキー (すべて任意):
  main_video        通しの動画のパス (本文では「今回見てほしいもの」に一度だけ出す)
  main_video_label  通しの動画の見出しに添える説明 (例: "3分12秒・8場面")
  fix_videos        直した箇所の確認動画のパス/導線の配列
  ear_videos        耳で確かめる確認動画のパス/導線の配列
  points            見るポイントの文字列の配列
  decision          判断してほしいこと
  fixed             「直したところ」の本文 (Markdown)
  ear               「耳で聞いてほしいところ」の本文 (Markdown)
  materials         「資料」のパス/URL の配列
  other             「そのほか」の本文 (Markdown)

更新 (--ticket) では、旧本文の要点を `bd update <id> --append-notes "YYYY-MM-DD: ..."` で
先に移してから description を全文置換する (--notes は使わない)。旧本文が空、または新しい
本文と同じなら notes を増やさない。新規作成では human ラベルを付ける (--no-human で外せる)。
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import date

HEADING_RE = re.compile(r"^##\s+(.+)$")
TICKET_ID_RE = re.compile(r"[A-Za-z0-9]+-[A-Za-z0-9.]+")
SUMMARY_MAX = 400


def _as_list(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    return [str(v) for v in value if str(v).strip()]


def _paths_block(label: str, paths: list[str], seen: set[str]) -> list[str]:
    """label と paths を並べる。通しの動画など既出のパスは出さない (一度だけ)。"""
    fresh = [p for p in paths if p not in seen]
    if not fresh:
        return []
    seen.update(fresh)
    return [label, "", *fresh, ""]


def build_body(spec: dict, date_str: str) -> str:
    seen: set[str] = set()
    lines: list[str] = []

    now: list[str] = []
    main = (spec.get("main_video") or "").strip()
    if main:
        label = (spec.get("main_video_label") or "").strip()
        head = f"通しの動画（{label}）" if label else "通しの動画"
        now.extend(_paths_block(head, [main], seen))
    now.extend(_paths_block("直した箇所の確認動画", _as_list(spec.get("fix_videos")), seen))
    now.extend(_paths_block("耳で確かめる確認動画", _as_list(spec.get("ear_videos")), seen))
    points = _as_list(spec.get("points"))
    if points:
        now.extend(["見るポイント", ""])
        now.extend(p if p.lstrip().startswith(("-", "•")) else f"- {p}" for p in points)
        now.append("")
    decision = (spec.get("decision") or "").strip()
    if decision:
        now.extend(["判断してほしいこと", "", decision, ""])
    if now:
        lines.extend([f"## 今回見てほしいもの（{date_str}）", "", *now])

    def section(title: str, body: str) -> None:
        body = body.strip()
        if body:
            lines.extend([f"## {title}", "", body, ""])

    section("直したところ", spec.get("fixed") or "")
    section("耳で聞いてほしいところ", spec.get("ear") or "")
    materials = [m for m in _as_list(spec.get("materials")) if m not in seen]
    section("資料", "\n".join(materials))
    section("そのほか", spec.get("other") or "")

    return "\n".join(lines).rstrip() + "\n" if lines else ""


def summarize_old_description(old_desc: str | None) -> str:
    """旧本文の要点を 1 行 (改行なし) にする。notes 用。"""
    heading = ""
    first = ""
    section = ""
    points: list[str] = []
    for raw in (old_desc or "").splitlines():
        s = raw.strip()
        m = HEADING_RE.match(s)
        if m:
            section = m.group(1).strip()
            heading = heading or section
            continue
        if not s or not section.startswith("今回見てほしいもの"):
            continue
        if s.startswith(("-", "•")):
            points.append(s.lstrip("-• ").strip())
        elif not first:
            first = s
    parts = [f"旧本文「{heading}」を置き換え" if heading else "旧本文を置き換え"]
    if first:
        parts.append(first)
    if points:
        parts.append("見るポイント: " + " / ".join(points[:3]))
    out = "。".join(p.rstrip("。") for p in parts) + "。"
    return re.sub(r"\s+", " ", out)[:SUMMARY_MAX]


def same_body(old_desc: str | None, new_body: str) -> bool:
    return (old_desc or "").strip() == new_body.strip()


def bd(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    r = subprocess.run(["bd", *args], capture_output=True, text=True, check=False)
    if check and r.returncode != 0:
        sys.stderr.write((r.stderr or "") + (r.stdout or ""))
        raise SystemExit(1)
    return r


def parse_ticket_id(stdout: str) -> str | None:
    try:
        obj = json.loads(stdout)
        if isinstance(obj, list) and obj:
            obj = obj[0]
        if isinstance(obj, dict) and obj.get("id"):
            return str(obj["id"])
    except json.JSONDecodeError:
        pass
    m = TICKET_ID_RE.search(stdout)
    return m.group(0) if m else None


def load_spec(path: str) -> dict:
    text = sys.stdin.read() if path == "-" else open(path, encoding="utf-8").read()
    spec = json.loads(text)
    if not isinstance(spec, dict):
        raise ValueError("spec must be a JSON object")
    return spec


def main() -> int:
    ap = argparse.ArgumentParser(description="Create or update a bd review ticket body.")
    ap.add_argument("--spec", required=True, help="spec JSON のパス (- で標準入力)")
    ap.add_argument("--title", default=None, help="チケットの title (新規では必須)")
    ap.add_argument("--ticket", default=None, help="更新するチケット id (無ければ新規作成)")
    ap.add_argument("--date", default=None, help="見出しと notes の日付 YYYY-MM-DD (既定: 今日)")
    ap.add_argument("--no-human", action="store_true", help="新規作成で human ラベルを付けない")
    ap.add_argument("--dry-run", action="store_true", help="本文を標準出力に出すだけ")
    args = ap.parse_args()

    try:
        spec = load_spec(args.spec)
    except (OSError, ValueError) as e:
        print(f"ERROR: spec を読めません: {e}", file=sys.stderr)
        return 1

    date_str = args.date or date.today().isoformat()
    body = build_body(spec, date_str)
    if not body:
        print("ERROR: spec から本文が組み立てられません (全てのキーが空)", file=sys.stderr)
        return 1

    if args.dry_run:
        sys.stdout.write(body)
        return 0

    if args.ticket:
        shown = bd(["show", args.ticket, "--json"])
        try:
            arr = json.loads(shown.stdout or "[]")
            old_desc = (arr[0] if isinstance(arr, list) and arr else arr).get("description") or ""
        except (json.JSONDecodeError, AttributeError, IndexError):
            old_desc = ""
        # 旧本文は積まない。要点を日付付きで notes へ移してから全文置換する。
        if old_desc.strip() and not same_body(old_desc, body):
            bd(["update", args.ticket, "--append-notes",
                f"{date_str}: {summarize_old_description(old_desc)}"])
        update = ["update", args.ticket, "--description", body]
        if args.title:
            update.extend(["--title", args.title])
        bd(update)
        print(args.ticket)
        return 0

    if not args.title:
        print("ERROR: 新規作成には --title が必要です", file=sys.stderr)
        return 1
    create = ["create", "--title", args.title, "--type", "task", "--priority", "2"]
    if not args.no_human:
        create.extend(["--labels", "human"])
    create.extend(["--description", body, "--json"])
    r = bd(create)
    ticket_id = parse_ticket_id(r.stdout or "")
    if not ticket_id:
        print("ERROR: bd create からチケット ID を取得できませんでした", file=sys.stderr)
        return 1
    print(ticket_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
