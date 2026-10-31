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

spec JSON のキーと制約は同じ scripts/ の post-review-ticket.schema.json が正本 (--help にも
同じ内容を出す)。--spec は本文を組み立てる前にこのスキーマで検査し、違反は 1 件ずつ理由を
出して終了コード 1 で止まる (dry-run も同じ)。

更新 (--ticket) では、旧本文の要点を `bd update <id> --append-notes "YYYY-MM-DD: ..."` で
先に移してから description を全文置換する (--notes は使わない)。旧本文が空、または新しい
本文と同じなら notes を増やさない。新規作成では human ラベルを付ける (--no-human で外せる)。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

HEADING_RE = re.compile(r"^##\s+(.+)$")
TICKET_ID_RE = re.compile(r"[A-Za-z0-9]+-[A-Za-z0-9.]+")
SUMMARY_MAX = 400
SCHEMA_PATH = Path(__file__).resolve().with_name("post-review-ticket.schema.json")


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


# ---- spec の検査 (JSON Schema の必要な範囲だけを標準ライブラリで実装) ----------------------
# 対応: $ref(#/$defs/..), type, enum, minProperties, required, properties,
#       additionalProperties:false, dependentRequired, minLength, maxLength, pattern,
#       minItems, maxItems, uniqueItems, items, x-path-exists, x-unique-main。


def load_schema() -> dict:
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        return json.load(f)


_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "boolean": bool,
    "integer": int,
    "number": (int, float),
}


def _type_ok(value: object, name: str) -> bool:
    if isinstance(value, bool) and name in ("integer", "number"):
        return False
    return isinstance(value, _TYPES[name])


def _resolve(ref: str, root: dict) -> dict:
    node: object = root
    for part in ref.removeprefix("#/").split("/"):
        node = node[part]  # type: ignore[index]
    return node  # type: ignore[return-value]


def _short(value: object) -> str:
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= 60 else text[:57] + "..."


def _check_path_exists(value: str, where: str, errors: list[str]) -> None:
    if not os.path.exists(value):
        errors.append(f"{where}: ファイルが存在しません: {value}")
    elif not os.path.isfile(value):
        errors.append(f"{where}: ファイルではありません: {value}")
    elif os.path.getsize(value) == 0:
        errors.append(f"{where}: ファイルが空です: {value}")


def _validate(value: object, schema: dict, root: dict, where: str, errors: list[str]) -> None:
    if "$ref" in schema:
        _validate(value, _resolve(schema["$ref"], root), root, where, errors)
    expected = schema.get("type")
    if expected and not _type_ok(value, expected):
        errors.append(f"{where}: {expected} である必要があります (実際: {type(value).__name__})")
        return
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{where}: {_short(schema['enum'])} のいずれかである必要があります")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{where}: 空、または短すぎます (最小 {schema['minLength']} 字)")
        elif len(value) > schema.get("maxLength", len(value)):
            errors.append(f"{where}: 長すぎます ({len(value)} 字 > 上限 {schema['maxLength']} 字)")
        elif "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{where}: 形式が合いません {_short(value)} — {schema.get('description', '')}")
        elif schema.get("x-path-exists"):
            _check_path_exists(value, where, errors)
    elif isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{where}: 要素が少なすぎます (最小 {schema['minItems']} 件。使わないなら キーごと省く)")
        if len(value) > schema.get("maxItems", len(value)):
            errors.append(f"{where}: 要素が多すぎます ({len(value)} 件 > 上限 {schema['maxItems']} 件)")
        if schema.get("uniqueItems"):
            dup = sorted({json.dumps(v, ensure_ascii=False) for i, v in enumerate(value) if v in value[:i]})
            for d in dup:
                errors.append(f"{where}: 重複した要素があります: {d}")
        if "items" in schema:
            for i, item in enumerate(value):
                _validate(item, schema["items"], root, f"{where}[{i}]", errors)
    elif isinstance(value, dict):
        if len(value) < schema.get("minProperties", 0):
            errors.append(f"{where}: キーが 1 つもありません")
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{where}: 必須キー {key} がありません")
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in props:
                    errors.append(f"{where}.{key}: 未知のキーです (使えるキー: {', '.join(props)})")
        for key, sub in props.items():
            if key in value:
                _validate(value[key], sub, root, f"{where}.{key}", errors)
        for key, needed in schema.get("dependentRequired", {}).items():
            if key in value:
                for n in needed:
                    if n not in value:
                        errors.append(f"{where}: {key} があるとき {n} も必須です")


def _check_unique_main(spec: dict, key: str, errors: list[str]) -> None:
    main = spec.get(key)
    if not isinstance(main, str) or not main.strip():
        return
    for name, value in spec.items():
        if name in (key, f"{key}_label"):
            continue
        texts = value if isinstance(value, list) else [value]
        if any(isinstance(t, str) and main in t for t in texts):
            errors.append(f"spec.{name}: {key} のパスを重複して書かないでください ({main})。本文では一度だけ出ます")


def validate_spec(spec: object, schema: dict | None = None) -> list[str]:
    """spec をスキーマで検査し、違反の理由を 1 件 1 行で返す (空なら適合)。"""
    schema = schema or load_schema()
    errors: list[str] = []
    _validate(spec, schema, schema, "spec", errors)
    if isinstance(spec, dict) and schema.get("x-unique-main"):
        _check_unique_main(spec, schema["x-unique-main"], errors)
    return errors


def schema_help(schema: dict) -> str:
    """--help の末尾に出す、スキーマから生成したキーの一覧。"""
    defs = schema.get("$defs", {})
    deps = schema.get("dependentRequired", {})
    lines = ["spec のキー (正本: " + SCHEMA_PATH.name + "。未知のキーは拒否):"]
    for key, sub in schema.get("properties", {}).items():
        resolved = {**defs.get(sub.get("$ref", "").rsplit("/", 1)[-1], {}), **sub}
        kind = resolved.get("type", "?")
        if kind == "array" and "items" in resolved:
            item = resolved["items"]
            item = {**defs.get(item.get("$ref", "").rsplit("/", 1)[-1], {}), **item}
            kind = f"array<{item.get('type', '?')}>"
        need = deps.get(key)
        lines.append(f"  {key} ({kind}): {resolved.get('description', '')}")
        if need:
            lines.append(f"      あるとき必須: {', '.join(need)}")
    lines.append("")
    lines.append(schema.get("description", ""))
    return "\n".join(lines)


def load_spec(path: str) -> dict:
    text = sys.stdin.read() if path == "-" else open(path, encoding="utf-8").read()
    spec = json.loads(text)
    if not isinstance(spec, dict):
        raise ValueError("spec must be a JSON object")
    return spec


def main() -> int:
    try:
        epilog = schema_help(load_schema())
    except (OSError, ValueError) as e:
        epilog = f"(スキーマを読めません: {e})"
    ap = argparse.ArgumentParser(
        description="Create or update a bd review ticket body.",
        epilog=epilog,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
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

    try:
        errors = validate_spec(spec)
    except (OSError, ValueError, KeyError) as e:
        print(f"ERROR: スキーマを読めません: {e}", file=sys.stderr)
        return 1
    if errors:
        for err in errors:
            print(f"ERROR: {err}", file=sys.stderr)
        print(f"ERROR: spec が {len(errors)} 件の制約に違反しています (本文は作っていません)", file=sys.stderr)
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
