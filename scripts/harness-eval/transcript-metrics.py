#!/usr/bin/env python3
"""Claude Code の transcript (jsonl) から、ハーネス評価 (bdboard-cm2q.9 の手順 B) の数値を出す (bdboard-eydu)。

読み取り専用で、標準ライブラリだけで動く (Python 3.9+)。本文 (プロンプト・返答・コマンドの引数・
ツール出力) は出力しない。出すのは件数・ID・agentType/model/spawnDepth・meta.json の description
(40 字まで)・拒否されたコマンドの先頭 2 語 (NAME=値 は NAME=… に伏せる) だけ。判定 (GREEN/YELLOW/RED)
はしない。数値だけを返し、閾値は評価プロンプト側が持つ。

  M6  Bash の実行タイムアウト件数 (10 分級 = long / それ未満 = short)
  M7  サブエージェントの稼働時間と、cache_read を除いたトークン (agentType / model 別と上位 N 件)
  M10 permissions.deny に止められた回数 (auto mode 分類器の拒否は classifier に分ける)
  M11 bdboard-worker のターン数
  M12 stop-ticket-gate の催促回数 (transcript = jsonl 1 本ごと)

入力: <DIR>/<sessionId>.jsonl と <DIR>/<sessionId>/subagents/agent-<id>.jsonl (+ 同じ名前の .meta.json)。
期間は --since / --until (両端を含む)。--since があるとき、mtime が since より古いファイルは読まない。

実 transcript の形から決めた規則 (旧手順 B が外していた点):
  - assistant の行は content ブロックごとに 1 行ずつ、同じ message.id で複製される (input / cache は同じ値、
    output_tokens だけ増える)。トークンもターン数も message.id ごとに 1 回、各項目の最大値で数える。
  - タイムアウトは「Bash の tool_result で is_error が true、かつ `Command timed out after <時間>`」だけ。
    `timed out after` という文字列だけで拾うと、curl の失敗やファイルを Read した結果の引用まで拾う。
  - 拒否も「is_error が true で、本文が Permission で始まる tool_result」だけ。
"""

import argparse
import datetime as dt
import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict

DEFAULT_DIR = "~/.claude/projects/-Users-takumi-Documents-src-private-src-bdboard"
LONG_TIMEOUT_SECONDS = 600
WORKER_TYPE = "bdboard-worker"
WORKER_TURN_WARN = 64
TS_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?$")
TIMEOUT_RE = re.compile(r"Command timed out after\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s)\s*)+)", re.I)
DURATION_RE = re.compile(r"(\d+(?:\.\d+)?)(ms|h|m|s)", re.I)
DENY_RE = re.compile(r"^Permission to use (\S+)(?: with command (.*))? has been denied\.?\s*$", re.S)
UNIT_SECONDS = {"ms": 0.001, "s": 1, "m": 60, "h": 3600}
USAGE_FIELDS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
PUBLIC_KEYS = ("agent_id", "agent_type", "model", "spawn_depth", "description", "hours", "first", "last",
               "tokens", "input_tokens", "cache_creation_input_tokens", "output_tokens", "turns")


def parse_ts(value):
    """ISO 8601 (Z / ±HH:MM / 無印=UTC / 日付のみ) を UTC の aware datetime にする。Python 3.9 の fromisoformat は使えない。"""
    match = TS_RE.match(value) if isinstance(value, str) else None
    if not match:
        return None
    year, month, day, hour, minute, second, fraction, zone = match.groups()
    try:
        offset = dt.timedelta()
        if zone and zone != "Z":
            zone_hours, zone_minutes = int(zone[1:3]), int(zone[4:6])
            if zone_hours > 23 or zone_minutes > 59:
                return None
            offset = (1 if zone[0] == "+" else -1) * dt.timedelta(hours=zone_hours, minutes=zone_minutes)
        local = dt.datetime(int(year), int(month), int(day), int(hour or 0), int(minute or 0), int(second or 0),
                            int(((fraction or "") + "000000")[:6]))
        return (local - offset).replace(tzinfo=dt.timezone.utc)
    except (ValueError, OverflowError):
        return None


def fmt_ts(value):
    return value.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def text_of_content(content):
    """message.content (文字列、または text ブロックの配列) の本文。tool_use / tool_result ブロックは無視する。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(block["text"] for block in content
                         if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str))
    return ""


def result_text(block):
    return text_of_content(block.get("content"))


def usage_values(message):
    usage = message.get("usage")
    usage = usage if isinstance(usage, dict) else {}
    return {key: usage[key] if isinstance(usage.get(key), int) and usage[key] > 0 else 0 for key in USAGE_FIELDS}


def duration_seconds(text):
    match = TIMEOUT_RE.search(text)
    tokens = DURATION_RE.findall(match.group(1)) if match else []
    if not tokens:
        return None
    return sum(float(number) * UNIT_SECONDS[unit.lower()] for number, unit in tokens)


def command_prefix(command):
    """拒否されたコマンドの先頭 2 語。NAME=値 は値を捨てて NAME=… にする (値が秘密のことがある)。"""
    words = (command or "").split()[:2]
    if not words:
        return "(none)"
    return " ".join((word.split("=", 1)[0] + "=…" if "=" in word else word)[:30] for word in words)


def read_meta(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        value = None
    value = value if isinstance(value, dict) else {}
    depth = value.get("spawnDepth")
    return {"agent_type": value.get("agentType") or "unknown", "model": value.get("model") or "unknown",
            "spawn_depth": depth if isinstance(depth, int) else None,
            "description": str(value.get("description") or "")[:40]}


class Totals:
    """全ファイルをまたいで足し込む集計。"""

    def __init__(self):
        self.timeouts = Counter()
        self.deny_tools = Counter()
        self.deny_prefixes = Counter()
        self.classifier = 0
        self.files = Counter()
        self.skipped_lines = 0
        self.nudges = []  # 催促が 1 回以上あった transcript ごとの回数
        self.subagents = []

    def add_tool_result(self, block, tool_names):
        """is_error な tool_result を、タイムアウト / 拒否 / 分類器の拒否に振り分ける。"""
        if block.get("is_error") is not True:
            return
        text = result_text(block)
        head = text.lstrip()
        if head.startswith("Permission"):
            if "auto mode" in head.lower() and "classifier" in head.lower():
                self.classifier += 1
                return
            denied = DENY_RE.match(head)
            if denied:
                self.deny_tools[denied.group(1)] += 1
                self.deny_prefixes[command_prefix(denied.group(2))] += 1
        elif tool_names.get(block.get("tool_use_id")) == "Bash" and "command timed out after" in head.lower():
            seconds = duration_seconds(head)
            self.timeouts["unparsed" if seconds is None else "long" if seconds >= LONG_TIMEOUT_SECONDS else "short"] += 1


def scan_file(path, kind, since, until, totals):
    """1 ファイルを 1 パスで読む。tool_use は tool_result より前に書かれているので、その場で id → 名前を引ける。"""
    tool_names, groups, models = {}, {}, Counter()
    first = last = None
    nudges = 0
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                entry = json.loads(line)
            except ValueError:
                totals.skipped_lines += 1
                continue
            if not isinstance(entry, dict):
                continue
            message = entry.get("message")
            message = message if isinstance(message, dict) else {}
            content = message.get("content")
            blocks = [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []
            for block in blocks:
                if block.get("type") == "tool_use" and block.get("id"):
                    tool_names[block["id"]] = block.get("name")
            stamp = parse_ts(entry.get("timestamp"))
            if stamp is None or stamp > until or (since is not None and stamp < since):
                continue
            first = stamp if first is None or stamp < first else first
            last = stamp if last is None or stamp > last else last
            for block in blocks:
                if block.get("type") == "tool_result":
                    totals.add_tool_result(block, tool_names)
            if entry.get("type") == "user":
                text = text_of_content(content)
                nudges += "stop-ticket-gate.sh" in text and "bdboard-harness: チケット" in text
            elif entry.get("type") == "assistant":
                if message.get("model"):
                    models[str(message["model"])] += 1
                group_id = message.get("id") or entry.get("uuid") or "line-%d" % len(groups)
                usage = usage_values(message)
                best = groups.setdefault(group_id, usage)
                for key in USAGE_FIELDS:
                    best[key] = max(best[key], usage[key])
    totals.files[kind] += 1
    if nudges:
        totals.nudges.append(nudges)
    if kind == "subagent" and first is not None:
        totals.subagents.append(subagent_stat(path, first, last, groups, models))


def subagent_stat(path, first, last, groups, models):
    meta = read_meta(path[:-len(".jsonl")] + ".meta.json")
    if meta["model"] == "unknown" and models:
        meta["model"] = sorted(models.items(), key=lambda item: (-item[1], item[0]))[0][0]
    sums = {key: sum(group[key] for group in groups.values()) for key in USAGE_FIELDS}
    return dict(meta, agent_id=os.path.basename(path)[len("agent-"):-len(".jsonl")],
                hours=round((last - first).total_seconds() / 3600, 2), first=fmt_ts(first), last=fmt_ts(last),
                tokens=sums["input_tokens"] + sums["cache_creation_input_tokens"] + sums["output_tokens"],
                input_tokens=sums["input_tokens"], cache_creation_input_tokens=sums["cache_creation_input_tokens"],
                output_tokens=sums["output_tokens"], turns=len(groups))


def public(item):
    return {key: item[key] for key in PUBLIC_KEYS}


def per_24h(count, hours):
    return round(count * 24 / hours, 1) if hours is not None and hours >= 6 else None


def build_result(totals, since, until, top):
    hours = round((until - since).total_seconds() / 3600, 2) if since is not None else None
    stats = totals.subagents
    by_group = defaultdict(list)
    for item in stats:
        by_group[(item["agent_type"], item["model"])].append(item)
    by_type_model = [{"agent_type": agent_type, "model": model, "runs": len(items),
                      "hours_total": round(sum(x["hours"] for x in items), 2),
                      "hours_max": round(max(x["hours"] for x in items), 2),
                      "tokens_total": sum(x["tokens"] for x in items)}
                     for (agent_type, model), items in sorted(by_group.items())]
    longest = min(stats, key=lambda x: (-x["hours"], -x["tokens"], x["agent_id"])) if stats else None
    top_items = sorted(stats, key=lambda x: (-x["tokens"], -x["hours"], x["agent_id"]))[:max(0, top)]
    workers = [x for x in stats if x["agent_type"] == WORKER_TYPE]
    deny = sum(totals.deny_tools.values())
    return {
        "period": {"since": fmt_ts(since) if since else None, "until": fmt_ts(until), "hours": hours},
        "files": {"main": totals.files["main"], "subagent": totals.files["subagent"],
                  "skipped_lines": totals.skipped_lines},
        "bash_timeouts": {"long": totals.timeouts["long"], "short": totals.timeouts["short"],
                          "unparsed": totals.timeouts["unparsed"],
                          "long_per_24h": per_24h(totals.timeouts["long"], hours)},
        "subagents": {"count": len(stats), "longest": public(longest) if longest else None,
                      "top_tokens": [public(x) for x in top_items], "by_type_model": by_type_model},
        "permission_denied": {"deny": deny, "deny_per_24h": per_24h(deny, hours), "classifier": totals.classifier,
                              "by_prefix": dict(sorted(totals.deny_prefixes.items())),
                              "by_tool": dict(sorted(totals.deny_tools.items()))},
        "worker_turns": {"workers": len(workers), "max": max([x["turns"] for x in workers] or [0]),
                         "ge64": sum(x["turns"] >= WORKER_TURN_WARN for x in workers)},
        "stop_gate_nudges": {"max_per_transcript": max(totals.nudges or [0]), "total": sum(totals.nudges),
                             "transcripts": len(totals.nudges)},
    }


def format_text(result, top):
    def per(value):
        return "n/a" if value is None else value

    period, files, timeouts = result["period"], result["files"], result["bash_timeouts"]
    subs, denied, workers, nudges = (result["subagents"], result["permission_denied"], result["worker_turns"],
                                     result["stop_gate_nudges"])
    lines = ["period: %s .. %s (%sh)" % (period["since"] or "-", period["until"], per(period["hours"])),
             "files: main=%d subagent=%d skipped_lines=%d" % (files["main"], files["subagent"], files["skipped_lines"]),
             "M6 bash_timeouts: long=%d (%s/24h) short=%d unparsed=%d" % (
                 timeouts["long"], per(timeouts["long_per_24h"]), timeouts["short"], timeouts["unparsed"])]
    longest = subs["longest"]
    if longest:
        lines.append('M7 subagents: %d runs; longest %sh %s/%s depth=%s "%s"' % (
            subs["count"], longest["hours"], longest["agent_type"], longest["model"], longest["spawn_depth"],
            longest["description"]))
    else:
        lines.append("M7 subagents: 0 runs")
    for group in subs["by_type_model"]:
        lines.append("  by agent_type/model: %s/%s runs=%d hours_total=%s hours_max=%s tokens=%d" % (
            group["agent_type"], group["model"], group["runs"], group["hours_total"], group["hours_max"],
            group["tokens_total"]))
    lines.append("  tokens top%d (input+cache_creation+output, cache_read excluded):" % max(0, top))
    for rank, item in enumerate(subs["top_tokens"], 1):
        lines.append('    %d. %d %s/%s %s %sh turns=%d "%s"' % (
            rank, item["tokens"], item["agent_type"], item["model"], item["agent_id"], item["hours"], item["turns"],
            item["description"]))
    lines += ["M10 permission_denied: deny=%d (%s/24h) classifier=%d" % (
                  denied["deny"], per(denied["deny_per_24h"]), denied["classifier"]),
              "  by prefix: " + (", ".join("%s x%d" % pair for pair in denied["by_prefix"].items()) or "-"),
              "  by tool: " + (", ".join("%s x%d" % pair for pair in denied["by_tool"].items()) or "-"),
              "M11 bdboard-worker turns: workers=%d max=%d ge64=%d" % (workers["workers"], workers["max"], workers["ge64"]),
              "M12 stop-ticket-gate nudges: max_per_transcript=%d total=%d transcripts=%d" % (
                  nudges["max_per_transcript"], nudges["total"], nudges["transcripts"])]
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Metrics from Claude Code transcripts (bdboard-eydu).")
    parser.add_argument("--dir", default=DEFAULT_DIR, help="transcripts directory (default: this repo's project dir)")
    parser.add_argument("--since", help="start of the period, inclusive (YYYY-MM-DD or ISO 8601; no zone = UTC)")
    parser.add_argument("--until", help="end of the period, inclusive (default: now)")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("--top", type=int, default=5, help="how many subagents to list by tokens (default 5)")
    args = parser.parse_args(argv)
    since = parse_ts(args.since) if args.since else None
    until = parse_ts(args.until) if args.until else dt.datetime.now(dt.timezone.utc)
    if args.since and since is None:
        parser.error("invalid --since timestamp: " + args.since)
    if until is None:
        parser.error("invalid --until timestamp: " + args.until)
    directory = os.path.expanduser(args.dir)
    if not os.path.isdir(directory):
        print("transcript directory does not exist: " + directory, file=sys.stderr)
        return 2
    totals = Totals()
    sources = (("main", sorted(glob.glob(os.path.join(directory, "*.jsonl")))),
               ("subagent", sorted(glob.glob(os.path.join(directory, "*", "subagents", "agent-*.jsonl")))))
    for kind, paths in sources:
        for path in paths:
            try:
                if since is not None and dt.datetime.fromtimestamp(os.path.getmtime(path), dt.timezone.utc) < since:
                    continue
                scan_file(path, kind, since, until, totals)
            except OSError:
                continue
    result = build_result(totals, since, until, args.top)
    print(json.dumps(result, ensure_ascii=False, indent=2) if args.format == "json" else format_text(result, args.top))
    return 0


if __name__ == "__main__":
    sys.exit(main())
