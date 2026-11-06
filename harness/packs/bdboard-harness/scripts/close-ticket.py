#!/usr/bin/env python3
"""チケットの close (マージ確認 → 証拠コメント → bd close → worktree 掃除) を 1 コマンドにする (bdboard-7yfj.5)。

SKILL.md 規律4 の手順 1〜4 の後半を 1 本にする。close はマージ後だけ (2026-10-31 に CI 赤のまま
close した事故の再発防止)。
検査 (読み取りのみ。すべて通るまで副作用なし):
  gh pr view <pr_url> --json state,mergeCommit → state が MERGED であること
  git fetch origin → mergeCommit が origin/<mainBranch> に含まれること (git merge-base --is-ancestor)
  worktree があるなら lsof -a -d cwd +D <worktree> で他プロセスが居ないこと
  bd show <ticket> で実在し status が closed でないこと
動作 (検査の後):
  bd comment <ticket> "PR: <url> merged (<mergeCommit 短縮>)" → bd close <ticket>
  → git worktree remove --force <worktree> → git branch -D <branch> → git remote prune origin
プロジェクト固有の場所や名前は持たない。

契約 `.claude/bdboard-harness.json` の prFlow を読む (bdboard-l1m1.12。mainBranch も読み、省略時は main)。
  pr (契約なし・prFlow なしも同じ): 上のとおり。pr_url が必須。
  direct / none / local-merge: PR を使わないので pr_url は渡さない (渡すと拒否)。gh と git fetch は使わず、
    ブランチ bd/<ticket> の先端が main の祖先であること (git merge-base --is-ancestor。local-merge はローカルの
    main を先に、direct / none は origin/main を先に見る) を「マージ済み」の証拠にする。
    証拠コメントは `PR: なし (prFlow=<値>, merged <先端の短縮 SHA>)`。local-merge ではブランチが必須。
    direct / none でブランチが無ければ検査なしで `PR: なし (prFlow=<値>)`。
  remote (origin) が無い repo では git remote prune origin を飛ばす。

spec JSON のキーと制約は同じ scripts/ の close-ticket.schema.json が正本 (--help にも同じ内容を
出す)。違反は 1 件ずつ `ERROR: spec.<path>: <理由>` を全件出して終了コード 1 で止まる
(dry-run も同じ)。

メインチェックアウトで実行する (linked worktree の中では拒否)。stdout の最終行は ticket id。
--dry-run は実行するコマンドを出すだけ。--keep-worktree で掃除 (worktree/ブランチ/prune) を飛ばす。worktree が無いときも掃除は全部飛ばす。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().with_name("close-ticket.schema.json")
SHORT_SHA = 9


# ---- spec の検査 (JSON Schema の必要な範囲だけを標準ライブラリで実装) ----------------------
# 対応: $ref(#/$defs/..), type, enum, required, properties, additionalProperties:false,
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


def _resolve(ref: str, root: dict) -> dict:
    node: object = root
    for part in ref.removeprefix("#/").split("/"):
        node = node[part]  # type: ignore[index]
    return node  # type: ignore[return-value]


def _short(value: object) -> str:
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= 60 else text[:57] + "..."


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


def pr_merge_info(pr_url: str) -> tuple[str | None, str | None, str]:
    """gh pr view (読み取りのみ) で (state, mergeCommit oid, 失敗理由) を返す。"""
    r = run(["gh", "pr", "view", pr_url, "--json", "state,mergeCommit"])
    if r.returncode != 0:
        return None, None, f"gh pr view {pr_url} に失敗しました: {(r.stderr or r.stdout).strip()}"
    try:
        obj = json.loads(r.stdout)
    except json.JSONDecodeError:
        return None, None, f"gh pr view {pr_url} の出力を読めません"
    if not isinstance(obj, dict):
        return None, None, f"gh pr view {pr_url} の出力が想定外です"
    commit = obj.get("mergeCommit")
    oid = commit.get("oid") if isinstance(commit, dict) else None
    return str(obj.get("state")), (oid if isinstance(oid, str) and oid else None), ""


def worktree_users(worktree: str) -> tuple[list[str], str]:
    """lsof -a -d cwd +D <worktree> で cwd をその下に置くプロセスの行を返す。(行, 失敗理由)。"""
    try:
        r = run(["lsof", "-a", "-d", "cwd", "+D", worktree])
    except OSError as e:
        return [], f"lsof を実行できません ({e}) — 他セッションが居ないことを確認できないので掃除できません"
    lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
    if lines and lines[0].startswith("COMMAND"):
        lines = lines[1:]
    return lines, ""


CONTRACT_REL = ".claude/bdboard-harness.json"
DEFAULT_MAIN_BRANCH = "main"
PR_FLOWS = ("pr", "direct", "none", "local-merge")


def load_contract() -> dict | None:
    """契約 JSON を読む。無い・壊れている・オブジェクトでないときは None (pr / main 扱い)。"""
    top = run(["git", "rev-parse", "--show-toplevel"]).stdout.strip()
    try:
        with open(Path(top or ".") / CONTRACT_REL, encoding="utf-8") as f:
            contract = json.load(f)
    except (OSError, ValueError):
        return None
    return contract if isinstance(contract, dict) else None


def contract_pr_flow(contract: dict | None) -> str:
    """契約の prFlow。契約・キーが無いときは pr。未知の値はそのまま返す (呼び出し側で拒否する)。"""
    if contract is None or "prFlow" not in contract:
        return "pr"
    value = contract["prFlow"]
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def contract_main_branch(contract: dict | None) -> str | None:
    """契約の mainBranch。省略時は main。git が別の意味に読む形なら None。"""
    value = DEFAULT_MAIN_BRANCH if contract is None or "mainBranch" not in contract else contract["mainBranch"]
    name = value.strip() if isinstance(value, str) else ""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", name) or ".." in name or name.endswith(("/", ".lock", ".")):
        return None
    return name


def resolve_main_ref(main_branch: str, prefer_local: bool) -> tuple[str, str] | None:
    """(git に渡す完全な ref, 表示名) を返す。local-merge はローカルの main を先に、それ以外は origin/main を先に見る。"""
    candidates = [(f"refs/heads/{main_branch}", main_branch), (f"refs/remotes/origin/{main_branch}", f"origin/{main_branch}")]
    for ref, shown in candidates if prefer_local else reversed(candidates):
        if run(["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"]).returncode == 0:
            return ref, shown
    return None


def branch_merge_evidence(branch: str, main_branch: str, pr_flow: str, problems: list[str]) -> str | None:
    """PR を使わない契約の「マージ済み」の証拠。ブランチ先端の SHA を返す (ブランチが無ければ None)。未取り込みは problems に足す。"""
    tip = run(["git", "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}^{{commit}}"]).stdout.strip()
    if not tip:
        if pr_flow == "local-merge":
            problems.append(f"ブランチ {branch} がありません — local-merge では「ブランチの先端が {main_branch} に取り込まれている」ことが close の証拠です")
        return None
    resolved = resolve_main_ref(main_branch, prefer_local=pr_flow == "local-merge")
    if resolved is None:
        problems.append(f"{main_branch} をローカルにも origin にも解決できません (契約の mainBranch を確認してください)")
    elif run(["git", "merge-base", "--is-ancestor", tip, resolved[0]]).returncode != 0:
        problems.append(f"ブランチ {branch} の先端 {tip[:SHORT_SHA]} が {resolved[1]} に取り込まれていません — close はマージ後だけ (--no-ff でマージしてから実行する)")
    return tip


def main() -> int:
    try:
        epilog = schema_help(load_schema())
    except (OSError, ValueError) as e:
        epilog = f"(スキーマを読めません: {e})"
    ap = argparse.ArgumentParser(
        description="Close a ticket after its PR is merged: evidence comment, bd close, worktree cleanup.",
        epilog=epilog,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--spec", required=True, help="spec JSON のパス (- で標準入力)")
    ap.add_argument("--dry-run", action="store_true", help="実行するコマンドを出すだけ (副作用なし)")
    ap.add_argument("--keep-worktree", action="store_true", help="worktree/ブランチの掃除を飛ばす")
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
    pr_url = spec.get("pr_url")
    branch = spec.get("branch", f"bd/{ticket}")
    worktree = os.path.abspath(spec.get("worktree", f".claude/worktrees/{ticket}"))

    gd = run(["git", "rev-parse", "--git-dir", "--git-common-dir"])
    parts = gd.stdout.split()
    if gd.returncode != 0 or len(parts) != 2:
        print("ERROR: git リポジトリの中で実行してください", file=sys.stderr)
        return 1
    if os.path.realpath(parts[0]) != os.path.realpath(parts[1]):
        print("ERROR: linked worktree の中では実行できません。メインチェックアウトで実行してください", file=sys.stderr)
        return 1

    # ---- 検査 (読み取りのみ。全件集めてから止まる) ----
    problems: list[str] = []
    status, why = ticket_status(ticket)
    if status is None:
        problems.append(why)
    elif status == "closed":
        problems.append(f"spec.ticket: 既に closed です: {ticket}")

    contract = load_contract()
    pr_flow = contract_pr_flow(contract)
    main_branch = contract_main_branch(contract)
    oid: str | None = None
    evidence_tip: str | None = None
    if pr_flow not in PR_FLOWS:
        problems.append(f"{CONTRACT_REL}: prFlow={pr_flow} は未知の値です ({' / '.join(PR_FLOWS)} のいずれか)")
    elif main_branch is None:
        problems.append(f"{CONTRACT_REL}: mainBranch は英数字と . _ / - だけのブランチ名である必要があります")
    elif pr_flow != "pr":
        if pr_url is not None:
            problems.append(f"spec.pr_url: この契約 (prFlow={pr_flow}) では PR を使いません。pr_url を外してください")
        else:
            evidence_tip = branch_merge_evidence(branch, main_branch, pr_flow, problems)
    elif pr_url is None:
        problems.append("spec.pr_url: 必須キー pr_url がありません (prFlow=pr。PR を使わない運用なら契約の prFlow を宣言する)")
    else:
        state, oid, why = pr_merge_info(pr_url)
        if state is None:
            problems.append(why)
        elif state != "MERGED":
            problems.append(f"spec.pr_url: PR の state が {state} です — close はマージ後だけ (MERGED になってから実行する。CI 赤・未マージで close しない)")
        elif oid is None:
            problems.append(f"spec.pr_url: MERGED なのに mergeCommit を取得できません: {pr_url}")
        else:
            f = run(["git", "fetch", "origin"])
            if f.returncode != 0:
                problems.append(f"git fetch origin に失敗しました: {(f.stderr or f.stdout).strip()}")
            elif run(["git", "merge-base", "--is-ancestor", oid, f"origin/{main_branch}"]).returncode != 0:
                problems.append(f"mergeCommit {oid[:SHORT_SHA]} が origin/{main_branch} に含まれていません (マージ先が {main_branch} でない、または fetch 後も未到達)")

    do_cleanup = (not args.keep_worktree) and os.path.isdir(worktree)
    if do_cleanup:
        users, why = worktree_users(worktree)
        if why:
            problems.append(why)
        elif users:
            problems.append(f"worktree {worktree} を使用中のプロセスがあります (掃除しない・close しない):\n  " + "\n  ".join(users))
    if problems:
        for p in problems:
            print(f"ERROR: {p}", file=sys.stderr)
        print(f"ERROR: {len(problems)} 件の検査に失敗しました (bd にも git にも書いていません)", file=sys.stderr)
        return 1

    if pr_flow == "pr":
        assert oid is not None
        evidence = f"PR: {pr_url} merged ({oid[:SHORT_SHA]})"
    elif evidence_tip:
        evidence = f"PR: なし (prFlow={pr_flow}, merged {evidence_tip[:SHORT_SHA]})"
    else:
        evidence = f"PR: なし (prFlow={pr_flow})"
    plan: list[list[str]] = [
        ["bd", "comment", ticket, evidence],
        ["bd", "close", ticket],
    ]
    if do_cleanup:
        plan.append(["git", "worktree", "remove", "--force", worktree])
    if do_cleanup:
        if run(["git", "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"]).returncode == 0:
            plan.append(["git", "branch", "-D", branch])
        # remote の無い repo (local-merge など) では prune する相手が無い。
        if "origin" in run(["git", "remote"]).stdout.split():
            plan.append(["git", "remote", "prune", "origin"])

    if args.dry_run:
        for cmd in plan:
            print(" ".join(cmd))
        print(ticket)
        return 0

    for i, cmd in enumerate(plan):
        r = run(cmd)
        if r.returncode != 0:
            sys.stderr.write(r.stderr + r.stdout)
            done = [" ".join(c) for c in plan[:i]]
            print(
                f"ERROR: `{' '.join(cmd)}` が失敗しました。実行済み: {done or 'なし'}。"
                "実行済みの手順は打ち直さず、失敗した以降のコマンドだけ手で打ってください",
                file=sys.stderr,
            )
            return 1
    print(ticket)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
