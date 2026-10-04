#!/usr/bin/env python3
"""Claude Code の transcript (jsonl) から、ハーネス評価 (bdboard-cm2q.9 の手順 B) の数値を出す (bdboard-eydu)。

読み取り専用で、標準ライブラリだけで動く (Python 3.9+)。本文 (プロンプト・返答・コマンドの引数・
ツール出力) は出力しない。出すのは件数・ID・agentType/model/spawnDepth・meta.json の description
(40 字まで)・拒否されたコマンドの先頭 2 語 (許可リスト方式、下記) だけ。判定 (GREEN/YELLOW/RED) はしない。
数値だけを返し、閾値は評価プロンプト側が持つ。

  M6  Bash の実行タイムアウト件数 (10 分級 = long / それ未満 = short)
  M7  サブエージェントの稼働時間と、cache_read を除いたトークン (agentType / 解決後 model 別と上位 N 件)
  M10 permissions.deny に止められた回数 (auto mode 分類器の拒否は classifier に分ける)
  M11 bdboard-worker の続行と結末 (評価手順 v2、2026-09-27)。M12 は v2 で廃止したので無い

入力: <DIR>/<sessionId>.jsonl と <DIR>/<sessionId>/subagents/agent-<id>.jsonl (+ 同じ名前の .meta.json)。
期間は --since / --until (両端を含む)。--since があるとき、mtime が since より古いファイルは読まない。
ゾーン無しの時刻 (引数も transcript の timestamp も) は UTC とみなす。日付だけの指定はその日の 00:00:00Z。
--since が --until より後なら終了コード 2。stdout / stderr は UTF-8 に固定する。

実 transcript の形から決めた規則 (旧手順 B が外していた点):
  - assistant の行は content ブロックごとに 1 行ずつ、同じ message.id で複製される (input / cache は同じ値、
    output_tokens だけ増える)。トークンもターン数も message.id ごとに 1 回、各項目の最大値で数える。
  - タイムアウトは「Bash の tool_result で is_error が true、かつ `Command timed out after <時間>`」だけ。
    `timed out after` という文字列だけで拾うと、curl の失敗やファイルを Read した結果の引用まで拾う。
    tool_use の id → 名前は期間外の行も含む全行から作る (tool_use が期間より前、結果が期間内のことがある)。
  - 拒否も「is_error が true で、本文の先頭が Permission の tool_result」だけ。本文の途中にある Permission
    (`bash: x.sh: Permission denied` など) は拾わない。先頭が Permission なのに既知の 2 形 (通常の拒否 / auto mode
    分類器) のどちらにも当たらないものは deny_unparsed に分ける (文言が変わったときに 0 に見えないように)。

output_tokens は下限 (lower bound) である。API 応答は stream の途中の行 (stop_reason が null、output_tokens は
開始時点の値) と、終わりの行 (stop_reason 付き、確定値) で記録されるが、終わりの行が記録されないことが多い
(実測: bdboard-worker の応答の 83%、サブエージェント全体でも多数)。その応答は開始時点の値しか残らないので、
output_tokens もそれを含む tokens も実際より小さい。終わりの行が無かった応答の数は responses_without_final_usage
(サブエージェント別は incomplete_responses) に出す。input / cache_creation は開始時点で確定しているので影響しない。

M11 (評価手順 v2 の「続行と結末」) の読み方:
  - 往復数 = 期間内の assistant の一意な message.id の数 (行数ではない)。
  - 区切り = type が user で、isMeta が true で、tool_result を含まない行。ただし、直前の区切り (先頭なら
    ファイルの始め) から数えて、新しい message.id が 1 つ以上出た後のものだけ。議長からの再開メッセージと
    バックグラウンドの完了通知がこれに当たる。続けて来た 2 つ目の isMeta 行、最初の依頼より前の isMeta 行、
    tool_result を含む行は区切りにしない。コンテキスト圧縮の要約 (isMeta の無い user 行) も区切りにしない。
    行の前後は時刻ではなくファイルの行順で決める。
  - segments = 区切りごとの一意 id 数。resumes = len(segments) - 1。最後の再開の後に id が 1 つも無くても
    その再開は数える (最後の区切りが 0)。
  - breakers = 一意 id 数が WORKER_MAX_TURNS (80、bdboard-worker の maxTurns) 以上の区切りの数。
  - continuations = ブレーカー到達の区切りの直後に再開が来た数 (v2 の「ブレーカー到達の直後に来た再開」)。
    resumes とは違い、80 に届いていない区切りの後の再開は数えない。
  - ends_on_breaker = 最後の区切りがブレーカー到達か (結末の分類に使う)。
  - 結末 (マージ済みか・PR 未マージか・放棄か) は M4 の first-parent 一覧と bd comments が要り、transcript
    だけでは出ない。ここでは description の `Worker: <短縮ID>` から ticket (bdboard-<短縮ID>、無ければ null)
    と ends_on_breaker までを出し、分類は手順 B 側が行う。`Worker:` が付いた description は一部だけ。

拒否されたコマンドの先頭 2 語は許可リスト方式で伏せる。1 語目は ^[A-Za-z][A-Za-z0-9._-]{0,23}$、2 語目は
^-{0,2}[a-z][a-z-]{0,19}$ に合うときだけ出し、合わない語は … にする (URL の userinfo、NAME=値、-pPASS、
引用符付きの値、記号や数字を含むトークンは出ない)。小文字とハイフンだけの 2 語目はサブコマンド名と区別できない
ので出る。3 語目以降は出さない。
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
WORKER_MAX_TURNS = 80  # .claude/agents/bdboard-worker.md の maxTurns
MASK = "…"
TS_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?$")
TIMEOUT_RE = re.compile(r"Command timed out after\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s)\s*)+)", re.I)
DURATION_RE = re.compile(r"(\d+(?:\.\d+)?)(ms|h|m|s)", re.I)
DENY_RE = re.compile(r"^Permission to use (\S+)(?: with command (.*))? has been denied\.?\s*$", re.S)
TICKET_RE = re.compile(r"\bWorker:\s*(?:bdboard-)?([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)")
FIRST_WORD_RE = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,23}$")
SECOND_WORD_RE = re.compile(r"^-{0,2}[a-z][a-z-]{0,19}$")
TOOL_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,59}$")
UNIT_SECONDS = {"ms": 0.001, "s": 1, "m": 60, "h": 3600}
USAGE_FIELDS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
PUBLIC_KEYS = ("agent_id", "agent_type", "model", "requested_model", "spawn_depth", "description", "hours", "first",
               "last", "tokens", "input_tokens", "cache_creation_input_tokens", "output_tokens", "turns",
               "incomplete_responses")
WORKER_KEYS = ("agent_id", "ticket", "description", "hours", "turns", "segments", "breakers", "resumes",
               "continuations", "ends_on_breaker")


def parse_ts(value):
    """ISO 8601 (Z / ±HH:MM / ゾーン無し=UTC / 日付のみ=その日の 0 時 UTC) を UTC の aware datetime にする。
    Python 3.9 の fromisoformat は Z を読めないので使わない。"""
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
    """拒否されたコマンドの先頭 2 語。許可リストに合う語だけ出し、それ以外は … にする (3 語目以降は出さない)。"""
    words = (command or "").split()[:2]
    if not words:
        return "(none)"
    shown = [words[0] if FIRST_WORD_RE.fullmatch(words[0]) else MASK]
    if len(words) > 1:
        shown.append(words[1] if SECOND_WORD_RE.fullmatch(words[1]) else MASK)
    return " ".join(shown)


def read_meta(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        value = None
    value = value if isinstance(value, dict) else {}
    depth = value.get("spawnDepth")
    description = str(value.get("description") or "")
    ticket = TICKET_RE.search(description)
    return {"agent_type": value.get("agentType") or "unknown", "requested_model": value.get("model") or "unknown",
            "spawn_depth": depth if isinstance(depth, int) else None, "description": description[:40],
            "ticket": "bdboard-" + ticket.group(1) if ticket else None}


class Totals:
    """全ファイルをまたいで足し込む集計。"""

    def __init__(self):
        self.timeouts = Counter()
        self.deny_tools = Counter()
        self.deny_prefixes = Counter()
        self.deny_unparsed = 0
        self.classifier = 0
        self.files = Counter()
        self.skipped_lines = 0
        self.subagents = []

    def add_tool_result(self, block, tool_names):
        """is_error な tool_result を、タイムアウト / 拒否 / 分類器の拒否に振り分ける。"""
        if block.get("is_error") is not True:
            return
        head = result_text(block).lstrip()
        if head.startswith("Permission"):
            if "auto mode" in head.lower() and "classifier" in head.lower():
                self.classifier += 1
                return
            denied = DENY_RE.match(head)
            if denied:
                tool = denied.group(1)
                self.deny_tools[tool if TOOL_NAME_RE.fullmatch(tool) else MASK] += 1
                self.deny_prefixes[command_prefix(denied.group(2))] += 1
            else:
                self.deny_unparsed += 1
        elif tool_names.get(block.get("tool_use_id")) == "Bash" and "command timed out after" in head.lower():
            seconds = duration_seconds(head)
            self.timeouts["unparsed" if seconds is None else "long" if seconds >= LONG_TIMEOUT_SECONDS else "short"] += 1


def scan_file(path, kind, since, until, totals):
    """1 ファイルを 1 パスで読む。tool_use は tool_result より前に書かれているので、その場で id → 名前を引ける。"""
    tool_names, groups, models = {}, {}, Counter()
    segments, new_ids = [], 0  # M11: 区切りごとの一意 id 数と、現在の区切りの新しい id の数
    first = last = None
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
            has_tool_result = False
            for block in blocks:
                if block.get("type") == "tool_result":
                    has_tool_result = True
                    totals.add_tool_result(block, tool_names)
            if entry.get("type") == "user":
                if entry.get("isMeta") is True and not has_tool_result and new_ids > 0:
                    segments.append(new_ids)
                    new_ids = 0
            elif entry.get("type") == "assistant":
                model = message.get("model")
                if model and model != "<synthetic>":
                    models[str(model)] += 1
                group_id = message.get("id") or entry.get("uuid") or "line-%d" % len(groups)
                usage = usage_values(message)
                if group_id not in groups:
                    groups[group_id] = {"usage": dict.fromkeys(USAGE_FIELDS, 0), "final": False}
                    new_ids += 1
                group = groups[group_id]
                for key in USAGE_FIELDS:
                    group["usage"][key] = max(group["usage"][key], usage[key])
                group["final"] = group["final"] or bool(message.get("stop_reason"))
    totals.files[kind] += 1
    if kind == "subagent" and first is not None:
        segments.append(new_ids)
        totals.subagents.append(subagent_stat(path, first, last, groups, models, segments))


def subagent_stat(path, first, last, groups, models, segments):
    meta = read_meta(path[:-len(".jsonl")] + ".meta.json")
    # 同じ agentType が meta の別名 (sonnet / claude-sonnet-5-5 …) で割れないよう、実際に応答したモデルで集計する。
    # transcript に応答が無いときだけ meta の値に戻る。
    resolved = sorted(models.items(), key=lambda item: (-item[1], item[0]))[0][0] if models else meta["requested_model"]
    sums = {key: sum(group["usage"][key] for group in groups.values()) for key in USAGE_FIELDS}
    breakers = sum(count >= WORKER_MAX_TURNS for count in segments)
    continuations = sum(count >= WORKER_MAX_TURNS for count in segments[:-1])
    return dict(meta, model=resolved, agent_id=os.path.basename(path)[len("agent-"):-len(".jsonl")],
                hours=round((last - first).total_seconds() / 3600, 2), first=fmt_ts(first), last=fmt_ts(last),
                tokens=sums["input_tokens"] + sums["cache_creation_input_tokens"] + sums["output_tokens"],
                input_tokens=sums["input_tokens"], cache_creation_input_tokens=sums["cache_creation_input_tokens"],
                output_tokens=sums["output_tokens"], turns=len(groups),
                incomplete_responses=sum(not group["final"] for group in groups.values()),
                segments=segments, breakers=breakers, resumes=len(segments) - 1, continuations=continuations,
                ends_on_breaker=segments[-1] >= WORKER_MAX_TURNS)


def pick(item, keys):
    return {key: item[key] for key in keys}


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
    workers = sorted((x for x in stats if x["agent_type"] == WORKER_TYPE), key=lambda x: (x["first"], x["agent_id"]))
    deny = sum(totals.deny_tools.values())
    return {
        "period": {"since": fmt_ts(since) if since else None, "until": fmt_ts(until), "hours": hours},
        "files": {"main": totals.files["main"], "subagent": totals.files["subagent"],
                  "skipped_lines": totals.skipped_lines},
        "bash_timeouts": {"long": totals.timeouts["long"], "short": totals.timeouts["short"],
                          "unparsed": totals.timeouts["unparsed"],
                          "long_per_24h": per_24h(totals.timeouts["long"], hours)},
        "subagents": {"count": len(stats), "responses": sum(x["turns"] for x in stats),
                      "responses_without_final_usage": sum(x["incomplete_responses"] for x in stats),
                      "longest": pick(longest, PUBLIC_KEYS) if longest else None,
                      "top_tokens": [pick(x, PUBLIC_KEYS) for x in top_items], "by_type_model": by_type_model},
        "permission_denied": {"deny": deny, "deny_per_24h": per_24h(deny, hours), "deny_unparsed": totals.deny_unparsed,
                              "classifier": totals.classifier,
                              "by_prefix": dict(sorted(totals.deny_prefixes.items())),
                              "by_tool": dict(sorted(totals.deny_tools.items()))},
        "worker_continuations": {"workers": len(workers),
                                 "max_segment": max([count for x in workers for count in x["segments"]] or [0]),
                                 "breakers": sum(x["breakers"] for x in workers),
                                 "continuations": sum(x["continuations"] for x in workers),
                                 "resumes": sum(x["resumes"] for x in workers),
                                 "items": [pick(x, WORKER_KEYS) for x in workers]},
    }


def format_text(result, top):
    def per(value):
        return "n/a" if value is None else value

    period, files, timeouts = result["period"], result["files"], result["bash_timeouts"]
    subs, denied, cont = result["subagents"], result["permission_denied"], result["worker_continuations"]
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
    lines.append("  responses=%d without_final_usage=%d: output_tokens and tokens are a lower bound" % (
        subs["responses"], subs["responses_without_final_usage"]))
    for group in subs["by_type_model"]:
        lines.append("  by agent_type/model (resolved): %s/%s runs=%d hours_total=%s hours_max=%s tokens>=%d" % (
            group["agent_type"], group["model"], group["runs"], group["hours_total"], group["hours_max"],
            group["tokens_total"]))
    lines.append("  tokens top%d (lower bound; input+cache_creation+output, cache_read excluded):" % max(0, top))
    for rank, item in enumerate(subs["top_tokens"], 1):
        lines.append('    %d. tokens>=%d %s/%s %s %sh turns=%d no_final=%d "%s"' % (
            rank, item["tokens"], item["agent_type"], item["model"], item["agent_id"], item["hours"], item["turns"],
            item["incomplete_responses"], item["description"]))
    lines += ["M10 permission_denied: deny=%d (%s/24h) deny_unparsed=%d classifier=%d" % (
                  denied["deny"], per(denied["deny_per_24h"]), denied["deny_unparsed"], denied["classifier"]),
              "  by prefix: " + (", ".join("%s x%d" % pair for pair in denied["by_prefix"].items()) or "-"),
              "  by tool: " + (", ".join("%s x%d" % pair for pair in denied["by_tool"].items()) or "-"),
              "M11 bdboard-worker continuations (v2): workers=%d max_segment=%d breakers=%d continuations=%d resumes=%d" % (
                  cont["workers"], cont["max_segment"], cont["breakers"], cont["continuations"], cont["resumes"])]
    for item in cont["items"]:
        lines.append('  %s ticket=%s turns=%d segments=%s breakers=%d continuations=%d ends_on_breaker=%s "%s"' % (
            item["agent_id"], item["ticket"] or "-", item["turns"], "+".join(str(n) for n in item["segments"]),
            item["breakers"], item["continuations"], "yes" if item["ends_on_breaker"] else "no", item["description"]))
    return "\n".join(lines)


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Metrics from Claude Code transcripts (bdboard-eydu).")
    parser.add_argument("--dir", default=DEFAULT_DIR, help="transcripts directory (default: this repo's project dir)")
    parser.add_argument("--since", help="start of the period, inclusive (YYYY-MM-DD or ISO 8601; no zone = UTC)")
    parser.add_argument("--until", help="end of the period, inclusive (default: now; no zone = UTC)")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("--top", type=int, default=5, help="how many subagents to list by tokens (default 5)")
    args = parser.parse_args(argv)
    since = parse_ts(args.since) if args.since else None
    until = parse_ts(args.until) if args.until else dt.datetime.now(dt.timezone.utc)
    if args.since and since is None:
        parser.error("invalid --since timestamp: " + args.since)
    if until is None:
        parser.error("invalid --until timestamp: " + args.until)
    if since is not None and since > until:
        parser.error("--since (%s) is after --until (%s)" % (fmt_ts(since), fmt_ts(until)))
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
