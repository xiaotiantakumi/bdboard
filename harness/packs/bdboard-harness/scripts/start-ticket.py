#!/usr/bin/env python3
"""チケット着手 (空き確認 → worktree 作成 → 成功時のみ claim) を 1 コマンドにする (bdboard-7yfj.3)。

SKILL.md 規律2 の手順 1〜3 を 1 本にする。排他の正本は git:
  git fetch origin → worktree とブランチの両方が無いことを確認
  → `git worktree add <path> -b <branch> <base>` (失敗 = 既存 = 排他負け)
  → 成功して初めて `bd update <ticket> --claim` → `--set-metadata bdboard.complexity=<c>`。
排他負けのときは「ほかのセッションが保持している」と出して非 0 で終わる。相手を戻さない・
kill しない・claim を打たない。プロジェクト固有の場所や名前は持たない。

spec JSON のキーと制約は同じ scripts/ の start-ticket.schema.json が正本 (--help にも同じ内容を
出す)。--spec は git/bd を呼ぶ前にこのスキーマで検査し、違反は 1 件ずつ
`ERROR: spec.<path>: <理由>` を全件出して終了コード 1 で止まる (dry-run も同じ)。ticket が
bd に実在し status が open/ready であることだけは bd show (読み取りのみ) で補って検査する。
副作用 (fetch・worktree 作成・bd の書き込み) は検査の後だけ。

メインチェックアウトで実行する (別 worktree の中から相対パスで add するとネストする。
linked worktree の中では拒否)。stdout の最終行は worktree の絶対パス。終了コード: 1 = 検査/実行の
失敗、2 = 排他負け。--dry-run は実行するコマンドを出すだけ。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().with_name("start-ticket.schema.json")
STARTABLE_STATUS = ("open", "ready")


# ---- spec の検査 (JSON Schema の必要な範囲だけを標準ライブラリで実装) ----------------------
# 対応: $ref(#/$defs/..), type, enum, required, properties, additionalProperties:false,
#       minLength, maxLength, pattern, x-parent-dir-exists。


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


def _check_parent_dir_exists(value: str, where: str, errors: list[str]) -> None:
    parent = os.path.dirname(os.path.abspath(value))
    if not os.path.isdir(parent):
        errors.append(f"{where}: 親ディレクトリが存在しません: {parent}")


def _validate(value: object, schema: dict, root: dict, where: str, errors: list[str]) -> None:
    if "$ref" in schema:
        _validate(value, _resolve(schema["$ref"], root), root, where, errors)
    expected = schema.get("type")
    if expected and not _type_ok(value, expected):
        errors.append(f"{where}: {expected} である必要があります (実際: {type(value).__name__})")
        return
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{where}: {_short(schema['enum'])} のいずれかである必要があります (実際: {_short(value)})")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{where}: 空、または短すぎます (最小 {schema['minLength']} 字)")
        elif len(value) > schema.get("maxLength", len(value)):
            errors.append(f"{where}: 長すぎます ({len(value)} 字 > 上限 {schema['maxLength']} 字)")
        elif "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{where}: 形式が合いません {_short(value)} — {schema.get('description', '')}")
        elif schema.get("x-parent-dir-exists"):
            _check_parent_dir_exists(value, where, errors)
    elif isinstance(value, dict):
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


def validate_spec(spec: object, schema: dict | None = None) -> list[str]:
    """spec をスキーマで検査し、違反の理由を 1 件 1 行で返す (空なら適合)。"""
    schema = schema or load_schema()
    errors: list[str] = []
    _validate(spec, schema, schema, "spec", errors)
    return errors


def schema_help(schema: dict) -> str:
    """--help の末尾に出す、スキーマから生成したキーの一覧。"""
    required = set(schema.get("required", []))
    lines = ["spec のキー (正本: " + SCHEMA_PATH.name + "。未知のキーは拒否):"]
    for key, sub in schema.get("properties", {}).items():
        mark = "必須" if key in required else "任意"
        lines.append(f"  {key} ({sub.get('type', '?')}, {mark}): {sub.get('description', '')}")
    lines.append("")
    lines.append(schema.get("description", ""))
    return "\n".join(lines)


def load_spec(path: str) -> dict:
    text = sys.stdin.read() if path == "-" else open(path, encoding="utf-8").read()
    spec = json.loads(text)
    if not isinstance(spec, dict):
        raise ValueError("spec must be a JSON object")
    return spec


# ---- 実行 -----------------------------------------------------------------------------------


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, check=False)


def ticket_status(ticket: str) -> tuple[str | None, str]:
    """bd show (読み取りのみ) で status を返す。(status, 失敗理由)。"""
    r = run(["bd", "show", ticket, "--json"])
    if r.returncode != 0:
        return None, f"チケット {ticket} を bd show で読めません: {(r.stderr or r.stdout).strip()}"
    try:
        obj = json.loads(r.stdout)
    except json.JSONDecodeError:
        return None, f"bd show {ticket} --json の出力を読めません"
    if isinstance(obj, list):
        obj = obj[0] if obj else None
    if not isinstance(obj, dict) or not isinstance(obj.get("status"), str):
        return None, f"bd show {ticket} --json に status がありません"
    return obj["status"], ""


def lost(what: str) -> int:
    print(
        f"ERROR: {what} — ほかのセッションが保持している可能性が高いので着手しません。"
        "相手を戻さない・kill しない・claim しない。次の候補のチケットへ進んでください",
        file=sys.stderr,
    )
    return 2


def main() -> int:
    try:
        epilog = schema_help(load_schema())
    except (OSError, ValueError) as e:
        epilog = f"(スキーマを読めません: {e})"
    ap = argparse.ArgumentParser(
        description="Start a ticket: create worktree (exclusion), then claim, in one command.",
        epilog=epilog,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--spec", required=True, help="spec JSON のパス (- で標準入力)")
    ap.add_argument("--dry-run", action="store_true", help="実行するコマンドを出すだけ (副作用なし)")
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
        print(f"ERROR: spec が {len(errors)} 件の制約に違反しています (何も実行していません)", file=sys.stderr)
        return 1

    ticket = spec["ticket"]
    branch = spec.get("branch", f"bd/{ticket}")
    worktree = os.path.abspath(spec.get("worktree", f".claude/worktrees/{ticket}"))
    base = spec.get("base", "origin/main")
    complexity = spec["complexity"]

    status, why = ticket_status(ticket)
    if status is None:
        print(f"ERROR: {why}", file=sys.stderr)
        return 1
    if status not in STARTABLE_STATUS:
        print(f"ERROR: spec.ticket: status が {status} です (着手できるのは {'/'.join(STARTABLE_STATUS)})", file=sys.stderr)
        return 1

    gd = run(["git", "rev-parse", "--git-dir", "--git-common-dir"])
    parts = gd.stdout.split()
    if gd.returncode != 0 or len(parts) != 2:
        print("ERROR: git リポジトリの中で実行してください", file=sys.stderr)
        return 1
    if os.path.realpath(parts[0]) != os.path.realpath(parts[1]):
        print("ERROR: linked worktree の中では実行できません (ネストする)。メインチェックアウトで実行してください", file=sys.stderr)
        return 1

    plan = [
        ["git", "fetch", "origin"],
        ["git", "worktree", "add", worktree, "-b", branch, base],
        ["bd", "update", ticket, "--claim"],
        ["bd", "update", ticket, "--set-metadata", f"bdboard.complexity={complexity}"],
    ]
    if args.dry_run:
        for cmd in plan:
            print(" ".join(cmd))
        print(worktree)
        return 0

    r = run(plan[0])
    if r.returncode != 0:
        sys.stderr.write(r.stderr + r.stdout)
        print("ERROR: git fetch origin に失敗しました (何も作っていません)", file=sys.stderr)
        return 1

    listing = run(["git", "worktree", "list", "--porcelain"]).stdout
    registered = {os.path.realpath(line[len("worktree "):]) for line in listing.splitlines() if line.startswith("worktree ")}
    if os.path.realpath(worktree) in registered or os.path.exists(worktree):
        return lost(f"worktree {worktree} は既に存在します")
    for ref in (f"refs/heads/{branch}", f"refs/remotes/origin/{branch}"):
        if run(["git", "show-ref", "--verify", "--quiet", ref]).returncode == 0:
            return lost(f"ブランチ {branch} は既に存在します ({ref})")

    r = run(plan[1])
    if r.returncode != 0:
        sys.stderr.write(r.stderr + r.stdout)
        return lost("git worktree add が失敗しました (排他負け)")

    for cmd in plan[2:]:
        r = run(cmd)
        if r.returncode != 0:
            sys.stderr.write(r.stderr + r.stdout)
            print(
                f"ERROR: worktree {worktree} は作成済みで `{' '.join(cmd)}` が失敗しました。"
                "worktree は消さず、失敗した bd コマンドだけ手で打ち直してください",
                file=sys.stderr,
            )
            return 1
    print(worktree)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
