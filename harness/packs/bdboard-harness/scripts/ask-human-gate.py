#!/usr/bin/env python3
"""ユーザーの回答待ち (human gate) を 1 コマンドで作る (bdboard-7yfj.2)。

bd gate create → bd update --description → bd comment → bd label add human の 4 手順を
1 本にする。質問の中身は JSON (--spec) で渡す。プロジェクト固有の場所や名前は持たない。

本文の見出し (references/question-template.md のテンプレ。無い節は出さない):
  ## 決めてほしいこと / ## 背景 / ## 選択肢 / ## 推奨 / ## 視覚的な確認 / ## 回答後の再開手順

spec JSON のキーと制約は同じ scripts/ の ask-human-gate.schema.json が正本 (--help にも
同じ内容を出す)。--spec は bd を呼ぶ前にこのスキーマで検査し、違反は 1 件ずつ
`ERROR: spec.<path>: <理由>` を全件出して終了コード 1 で止まる (dry-run も同じ)。副作用
(bd の書き込み) は検査の後だけ。

--review-after <id> があれば、作業チケットに bdboard.review_after=<id> を付ける
(確認待ちレーンの並び順だけに効き、ブロックはしない。bd dep add は使わない)。
stdout の最終行は gate id。--dry-run は本文を出すだけ。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

TICKET_ID_RE = re.compile(r"[A-Za-z0-9]+-[A-Za-z0-9.]+")
TITLE_MAX = 80
SCHEMA_PATH = Path(__file__).resolve().with_name("ask-human-gate.schema.json")


def build_body(spec: dict) -> str:
    lines: list[str] = []

    def section(title: str, body_lines: list[str]) -> None:
        lines.extend([f"## {title}", "", *body_lines, ""])

    section("決めてほしいこと", [spec["decision"].strip()])
    section("背景", [spec["background"].strip()])
    section("選択肢", [f"- **{o['label']}** — 帰結: {o['consequence']}" for o in spec["options"]])
    rec = spec["recommend"]
    reason = (rec.get("reason") or "").strip()
    if rec["choice"] == "none":
        rec_lines = [f"推奨なし — {reason}"]
    else:
        rec_lines = [f"{rec['choice']}" + (f" — {reason}" if reason else "")]
    section("推奨", rec_lines)

    visual = spec.get("visual") or {}
    if visual:
        v: list[str] = []
        shots = visual.get("screenshots") or []
        if shots:
            v.append("スクリーンショット (gate 本体と作業チケットの両方に添付する):")
            v.extend(f"- {s}" for s in shots)
        if visual.get("preview_url"):
            v.append(f"プレビュー: {visual['preview_url']}")
        section("視覚的な確認", v)

    resume = spec["resume"]
    steps = [f"{i}. {s}" for i, s in enumerate(resume["steps"], 1)]
    section("回答後の再開手順", [f"worktree: {resume['worktree']}", *steps])
    return "\n".join(lines).rstrip() + "\n"


def make_title(spec: dict) -> str:
    first = spec["decision"].strip().splitlines()[0].strip()
    if len(first) > TITLE_MAX:
        first = first[: TITLE_MAX - 1] + "…"
    return f"Gate: {first}"


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
#       minItems, maxItems, uniqueItems, items,
#       x-path-exists, x-dir-exists, x-labels-unique, x-recommend-in-options。


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


def _check_dir_exists(value: str, where: str, errors: list[str]) -> None:
    if not os.path.exists(value):
        errors.append(f"{where}: ディレクトリが存在しません: {value}")
    elif not os.path.isdir(value):
        errors.append(f"{where}: ディレクトリではありません: {value}")


def _check_labels_unique(value: list, where: str, errors: list[str]) -> None:
    seen: set[str] = set()
    for i, item in enumerate(value):
        label = item.get("label") if isinstance(item, dict) else None
        if not isinstance(label, str):
            continue
        if label in seen:
            errors.append(f"{where}[{i}].label: label が重複しています: {label}")
        seen.add(label)


def _check_recommend(value: dict, where: str, root_value: object, errors: list[str]) -> None:
    choice = value.get("choice")
    if not isinstance(choice, str):
        return
    if choice == "none":
        if not isinstance(value.get("reason"), str) or not value["reason"].strip():
            errors.append(f"{where}.reason: choice が none のときは reason が必須です (なぜ推奨が無いか)")
        return
    options = root_value.get("options") if isinstance(root_value, dict) else None
    labels = [o.get("label") for o in options if isinstance(o, dict)] if isinstance(options, list) else []
    if choice not in labels:
        errors.append(f"{where}.choice: options の label のどれか、または none である必要があります: {_short(choice)}")


def _validate(value: object, schema: dict, root: dict, where: str, errors: list[str], top: object = None) -> None:
    if "$ref" in schema:
        _validate(value, _resolve(schema["$ref"], root), root, where, errors, top)
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
        elif schema.get("x-dir-exists"):
            _check_dir_exists(value, where, errors)
    elif isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{where}: 要素が少なすぎます (最小 {schema['minItems']} 件。使わないなら キーごと省く)")
        if len(value) > schema.get("maxItems", len(value)):
            errors.append(f"{where}: 要素が多すぎます ({len(value)} 件 > 上限 {schema['maxItems']} 件)")
        if schema.get("uniqueItems"):
            dup = sorted({json.dumps(v, ensure_ascii=False) for i, v in enumerate(value) if v in value[:i]})
            for d in dup:
                errors.append(f"{where}: 重複した要素があります: {d}")
        if schema.get("x-labels-unique"):
            _check_labels_unique(value, where, errors)
        if "items" in schema:
            for i, item in enumerate(value):
                _validate(item, schema["items"], root, f"{where}[{i}]", errors, top)
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
                _validate(value[key], sub, root, f"{where}.{key}", errors, top)
        for key, needed in schema.get("dependentRequired", {}).items():
            if key in value:
                for n in needed:
                    if n not in value:
                        errors.append(f"{where}: {key} があるとき {n} も必須です")
        if schema.get("x-recommend-in-options"):
            _check_recommend(value, where, top, errors)


def validate_spec(spec: object, schema: dict | None = None) -> list[str]:
    """spec をスキーマで検査し、違反の理由を 1 件 1 行で返す (空なら適合)。"""
    schema = schema or load_schema()
    errors: list[str] = []
    _validate(spec, schema, schema, "spec", errors, spec)
    return errors


def schema_help(schema: dict) -> str:
    """--help の末尾に出す、スキーマから生成したキーの一覧。"""
    defs = schema.get("$defs", {})
    required = set(schema.get("required", []))
    lines = ["spec のキー (正本: " + SCHEMA_PATH.name + "。未知のキーは拒否):"]
    for key, sub in schema.get("properties", {}).items():
        resolved = {**defs.get(sub.get("$ref", "").rsplit("/", 1)[-1], {}), **sub}
        kind = resolved.get("type", "?")
        if kind == "array" and "items" in resolved:
            item = resolved["items"]
            item = {**defs.get(item.get("$ref", "").rsplit("/", 1)[-1], {}), **item}
            kind = f"array<{item.get('type', '?')}>"
        mark = "必須" if key in required else "任意"
        lines.append(f"  {key} ({kind}, {mark}): {resolved.get('description', '')}")
        for sub_key, sub_schema in resolved.get("properties", {}).items():
            lines.append(f"      .{sub_key}: {sub_schema.get('description', '')}")
        if kind == "array<object>":
            for sub_key, sub_schema in resolved["items"].get("properties", {}).items():
                lines.append(f"      [].{sub_key}: {sub_schema.get('description', '')}")
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
        description="Create a bd human gate (question) in one command.",
        epilog=epilog,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--spec", required=True, help="spec JSON のパス (- で標準入力)")
    ap.add_argument("--review-after", default=None, help="先に確認してほしいチケット id (並び順だけ。ブロックしない)")
    ap.add_argument("--dry-run", action="store_true", help="本文を標準出力に出すだけ (bd は呼ばない)")
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
    if args.review_after is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.,-]*", args.review_after):
        errors.append(f"--review-after: チケット id (カンマ区切り可) である必要があります: {args.review_after}")
    if errors:
        for err in errors:
            print(f"ERROR: {err}", file=sys.stderr)
        print(f"ERROR: spec が {len(errors)} 件の制約に違反しています (gate は作っていません)", file=sys.stderr)
        return 1

    body = build_body(spec)
    if args.dry_run:
        sys.stdout.write(body)
        return 0

    ticket = spec["ticket"]
    r = bd(["gate", "create", "--type=human", "--blocks", ticket, "--title", make_title(spec), "--json"])
    gate_id = parse_ticket_id(r.stdout or "")
    if not gate_id:
        print("ERROR: bd gate create から gate id を取得できませんでした", file=sys.stderr)
        return 1
    try:
        bd(["update", gate_id, "--description", body])
        bd(["comment", ticket, f"質問は gate {gate_id} を参照（bd show {gate_id}）"])
        bd(["label", "add", ticket, "human"])
        if args.review_after:
            bd(["update", ticket, "--set-metadata", f"bdboard.review_after={args.review_after}"])
    except SystemExit:
        print(
            f"ERROR: gate {gate_id} は作成済みで途中の手順が失敗しました。gate create は再実行せず、"
            f"失敗した bd コマンドだけ手で打ち直してください (gate は {ticket} をブロック済み)",
            file=sys.stderr,
        )
        raise
    print(gate_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
