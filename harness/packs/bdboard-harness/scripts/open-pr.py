#!/usr/bin/env python3
"""PR 作成 (verify:quick → push → gh pr create → bd comment PR: → auto-merge) を 1 コマンドにする (bdboard-7yfj.4)。

worktree-pr-flow.md の「PR 作成」を 1 本にし、`Closes: <ticket>` と `PR:` コメントの欠落を機械で防ぐ。
プロジェクト固有の場所や名前は持たない (npm の verify:quick / check:commits は package.json の
スクリプト名で呼ぶ)。

spec JSON のキーと制約は同じ scripts/ の open-pr.schema.json が正本 (--help にも同じ内容を出す)。
--spec は副作用の前にこのスキーマと、git/bd/npm (読み取りのみ) の状態検査で調べ、違反は 1 件ずつ
`ERROR: spec.<path>: <理由>` / `ERROR: <理由>` を全件出して終了コード 1 で止まる (dry-run も同じ)。
副作用 (verify・push・gh pr create・bd comment・auto-merge) は検査の後だけ。

動作: npm run verify:quick → git push -u origin <branch> → gh pr create → bd comment <ticket> "PR: <url>"
→ complexity が low/med なら gh pr merge --auto --squash --delete-branch (high は打たず
「議長のレビュー待ち」と出す)。stdout の最終行は PR URL。--dry-run は実行するコマンドを出すだけ。
--skip-verify <理由> は verify:quick を飛ばし、理由を bd comment に残す。
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().with_name("open-pr.schema.json")
GENERATED_LINE = "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
BASE = "origin/main"


# ---- spec の検査 (JSON Schema の必要な範囲だけを標準ライブラリで実装) ----------------------
# 対応: type, enum, const, required, properties, additionalProperties:false,
#       minLength, maxLength, pattern。


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


def _short(value: object) -> str:
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= 60 else text[:57] + "..."


def _validate(value: object, schema: dict, where: str, errors: list[str]) -> None:
    expected = schema.get("type")
    if expected and not _type_ok(value, expected):
        errors.append(f"{where}: {expected} である必要があります (実際: {type(value).__name__})")
        return
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{where}: {_short(schema['enum'])} のいずれかである必要があります")
    if "const" in schema and value != schema["const"]:
        errors.append(f"{where}: {_short(schema['const'])} である必要があります — {schema.get('description', '')}")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{where}: 空、または短すぎます (最小 {schema['minLength']} 字)")
        elif len(value) > schema.get("maxLength", len(value)):
            errors.append(f"{where}: 長すぎます ({len(value)} 字 > 上限 {schema['maxLength']} 字)")
        elif "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{where}: 形式が合いません {_short(value)} — {schema.get('description', '')}")
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
                _validate(value[key], sub, f"{where}.{key}", errors)


def validate_spec(spec: object, schema: dict | None = None) -> list[str]:
    """spec をスキーマで検査し、違反の理由を 1 件 1 行で返す (空なら適合)。"""
    schema = schema or load_schema()
    errors: list[str] = []
    _validate(spec, schema, "spec", errors)
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


# ---- 状態の検査 (読み取りのみ) ------------------------------------------------------------


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, check=False)
    except OSError as e:
        return subprocess.CompletedProcess(cmd, 127, "", str(e))


def run_checked(cmd: list[str], what: str) -> subprocess.CompletedProcess[str]:
    r = run(cmd)
    if r.returncode != 0:
        sys.stderr.write((r.stderr or "") + (r.stdout or ""))
        print(f"ERROR: {what} が失敗しました (終了コード {r.returncode})。以降の手順は実行していません", file=sys.stderr)
        raise SystemExit(1)
    return r


def read_ticket(ticket: str, errors: list[str]) -> dict | None:
    r = run(["bd", "show", ticket, "--json"])
    if r.returncode != 0:
        errors.append(f"spec.ticket: bd にチケットが見つかりません: {ticket}")
        return None
    try:
        obj = json.loads(r.stdout)
    except json.JSONDecodeError:
        errors.append(f"spec.ticket: bd show の出力を読めません: {ticket}")
        return None
    if isinstance(obj, list):
        obj = obj[0] if obj else None
    if not isinstance(obj, dict):
        errors.append(f"spec.ticket: bd にチケットが見つかりません: {ticket}")
        return None
    if obj.get("status") != "in_progress":
        errors.append(f"spec.ticket: status が in_progress ではありません ({obj.get('status')})。先に start-ticket で着手してください")
    return obj


def check_git_state(ticket: str, branch: str, errors: list[str]) -> bool:
    """git の状態を検査する。linked worktree でなければ以降を調べず False を返す。"""
    gd = run(["git", "rev-parse", "--path-format=absolute", "--git-dir"]).stdout.strip()
    common = run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.strip()
    if not gd or gd == common:
        errors.append("カレントが linked worktree ではありません (チケットの worktree の中で実行してください)")
        return False
    current = run(["git", "branch", "--show-current"]).stdout.strip()
    if current != branch:
        errors.append(f"カレントのブランチが {branch} ではありません (実際: {current or '(detached)'})")
    if run(["git", "status", "--porcelain"]).stdout.strip():
        errors.append("未コミットの変更があります。コミットしてから実行してください")
    ahead = run(["git", "rev-list", "--count", f"{BASE}..HEAD"])
    if ahead.returncode != 0:
        errors.append(f"{BASE} を解決できません (git fetch origin を先に)")
        return True
    if int(ahead.stdout.strip() or "0") == 0:
        errors.append(f"{BASE} より先行するコミットがありません")
    names = run(["git", "diff", "--name-only", f"{BASE}...HEAD"]).stdout.splitlines()
    beads = [n for n in names if n == ".beads" or n.startswith(".beads/")]
    if beads:
        errors.append(f".beads/ 配下の変更が diff に含まれています (PR に含めない): {', '.join(beads[:5])}")
    cc = run(["npm", "run", "check:commits", "--", "--range", f"{BASE}..HEAD"])
    if cc.returncode != 0:
        detail = (cc.stdout or cc.stderr or "").strip().splitlines()
        errors.append("コミットメッセージが check:commits を通りません: " + (" / ".join(detail[-3:]) if detail else "(出力なし)"))
    return True


def build_body(spec: dict) -> str:
    return f"Closes: {spec['ticket']}\n\n{spec['summary'].strip()}\n\n{GENERATED_LINE}"


def main() -> int:
    try:
        epilog = schema_help(load_schema())
    except (OSError, ValueError) as e:
        epilog = f"(スキーマを読めません: {e})"
    ap = argparse.ArgumentParser(
        description="Open a PR for a bd ticket in one command.",
        epilog=epilog,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--spec", required=True, help="spec JSON のパス (- で標準入力)")
    ap.add_argument("--dry-run", action="store_true", help="実行するコマンドを出すだけ (副作用なし)")
    ap.add_argument("--skip-verify", metavar="REASON", default=None, help="verify:quick を飛ばす。理由を bd comment に残す")
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
    if args.skip_verify is not None and not args.skip_verify.strip():
        errors.append("--skip-verify: 理由が空です")

    ticket = spec.get("ticket") if isinstance(spec.get("ticket"), str) else None
    title = spec.get("title") if isinstance(spec.get("title"), str) else None
    if ticket and title:
        m = re.match(r"^[a-z]+\(([^()]+)\):", title)
        if m and m.group(1) != ticket:
            errors.append(f"spec.title: 括弧の中が ticket と一致しません ({m.group(1)} != {ticket})")

    complexity = spec.get("complexity") if spec.get("complexity") in ("low", "med", "high") else None
    if ticket and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9]+)*", ticket):
        issue = read_ticket(ticket, errors)
        if issue is not None and "complexity" not in spec:
            meta = issue.get("metadata")
            value = meta.get("bdboard.complexity") if isinstance(meta, dict) else None
            if value in ("low", "med", "high"):
                complexity = value
            else:
                errors.append("spec.complexity: 省略時は bd metadata bdboard.complexity が要りますが、ありません (spec に書くか start-ticket で記録)")
        check_git_state(ticket, f"bd/{ticket}", errors)

    if errors:
        for err in errors:
            print(f"ERROR: {err}", file=sys.stderr)
        print(f"ERROR: {len(errors)} 件の違反があります (verify・push・PR 作成はしていません)", file=sys.stderr)
        return 1

    assert ticket and complexity
    branch = f"bd/{ticket}"
    body = build_body(spec)
    steps: list[tuple[str, list[str]]] = []
    if args.skip_verify is None:
        steps.append(("verify", ["npm", "run", "verify:quick"]))
    steps.append(("push", ["git", "push", "-u", "origin", branch]))

    if args.dry_run:
        if args.skip_verify is not None:
            print(f"+ bd comment {ticket} {json.dumps('verify:quick を省略: ' + args.skip_verify.strip(), ensure_ascii=False)}")
        for _, cmd in steps:
            print("+ " + " ".join(cmd))
        print(f"+ gh pr create --title {json.dumps(spec['title'], ensure_ascii=False)} --body {json.dumps(body, ensure_ascii=False)}")
        print(f'+ bd comment {ticket} "PR: <url>"')
        if complexity == "high":
            print("(complexity high: auto-merge は打たない。議長のレビュー待ち)")
        else:
            print("+ gh pr merge <url> --auto --squash --delete-branch")
        return 0

    if args.skip_verify is not None:
        run_checked(["bd", "comment", ticket, "verify:quick を省略: " + args.skip_verify.strip()], "bd comment (skip-verify の理由)")
    for what, cmd in steps:
        run_checked(cmd, what)
    created = run_checked(["gh", "pr", "create", "--title", spec["title"], "--body", body], "gh pr create")
    lines = [l.strip() for l in created.stdout.splitlines() if l.strip()]
    url = lines[-1] if lines else ""
    if not url.startswith("http"):
        print(f"ERROR: gh pr create の出力から PR URL を取得できませんでした: {created.stdout!r}", file=sys.stderr)
        return 1
    try:
        run_checked(["bd", "comment", ticket, f"PR: {url}"], "bd comment PR:")
        if complexity == "high":
            print("complexity high: auto-merge は有効にしていません。議長のレビュー待ち")
        else:
            run_checked(["gh", "pr", "merge", url, "--auto", "--squash", "--delete-branch"], "gh pr merge --auto")
            print("auto-merge を有効にしました (required checks が緑でマージ)")
    except SystemExit:
        print(f"ERROR: PR {url} は作成済みです。失敗したコマンドだけ手で打ち直してください", file=sys.stderr)
        raise
    print(url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
