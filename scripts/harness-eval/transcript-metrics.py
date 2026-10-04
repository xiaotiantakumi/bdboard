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
    だけでは出ない。ここでは ticket と ends_on_breaker までを出し、分類は手順 B 側が行う。
  - ticket (確定) は description の `Worker: <短縮ID>` から (bdboard-<短縮ID>、無ければ null)。`Worker:` が付いた
    description は一部だけなので、外れたときは先頭の短縮 ID を ticket_hint (未確認、bdboard-<短縮ID>、無ければ
    null) に出す (bdboard-5iwh)。形は `<短縮ID>: …`、`Implement|Fix <短縮ID> …` (`bdboard-` 付きも可)、そして
    動詞も `:` も無い先頭の 3〜6 字の小文字の語 (`<短縮ID> …`) で、最後の形は ID でない普通の語も拾う
    (`review the PR` は bdboard-review、`fix: typo` は bdboard-fix、`Implement the …` は bdboard-the)。
    語として ID の形をしているだけで bd に実在するかは見ていないので、取りこぼしを減らす代わりに偽陽性を含む。
    手順 B 側が `bd show` で確かめてから分類する。ticket が取れたときの ticket_hint は null (二重に出さない)。
    TICKET_RE は description の全体 (40 字で切る前) から探す。これは 5iwh より前からの挙動で、変えていない。
  - 注意 (bdboard-5iwh): bdboard-worker が 80 往復で打ち切られたあと、議長は「作業を進めず報告だけして終了して」と
    SendMessage することがある (bdboard-worker.md の「budget 停止を受けた呼び出し元」)。これも isMeta の再開行と
    して現れ、上の定義では continuations に数えられる。本物の続行 (作業を再開させる指示) と「報告だけ」の再開は
    transcript の形では区別できないので、continuations は「ブレーカー到達の直後に再開が来た数」であって「作業を
    続けさせた数」ではない (上限)。区別が要るときは bd のコメント (milestone / PR) と突き合わせる。

拒否されたコマンドの先頭 2 語は許可リスト方式で伏せる。1 語目は ^[a-z][a-z0-9._-]{0,23}$ に合い、かつ数字を 3 つ
以上含まないときだけ出す。2 語目は ^(?:--[a-z][a-z-]{0,19}|-[A-Za-z]{1,3}|[a-z][a-z-]{0,19})$ に合い、かつフラグ
形 (-x / --name)、または 1 語目が SUBCOMMAND_CLIS (git / npm / bd …) の語、または 2 語目自体が SUBCOMMAND_CLIS
の語 (`VAR=値 npm …` のように 1 語目が伏せられたとき) のときだけ出す。合わない語は … にする (URL の userinfo、
NAME=値、-pPASS、`printf <値>` のような自由な引数、引用符付きの値、記号や数字を含むトークン、AKIA… / sk-… /
xoxb-… 形のキーは出ない)。3 語目以降は出さない。claude / codex は 2 語目が自由なプロンプトになりうるので
SUBCOMMAND_CLIS に入れない (`claude <語>` は `claude …`)。

これは完全な秘密除去ではなく、通ってしまう形がある:
  - npx の 2 語目 (パッケージ名) は出る。SUBCOMMAND_CLIS に入っているため。
  - -p のような短いフラグの直後の 1〜2 字の値 (`-pab`) は、フラグ形 -[A-Za-z]{1,3} に合うので出る。
  - description では、16 字未満の値、英字だけの値、全角の `＝` を含む語は伏せられずに出る (下記)。

サブエージェントの description (meta.json) は 40 字に切る前に伏せる。空白ではなく ASCII の連なり ([!-~]+) ごとに
見る (日本語の文字を 16 字の数に入れない)。`://` / `@` / `=` を含む連なりと、16 字以上で英字と数字が混ざる連なり
は … にする。`bdboard-<ID>[.N]` の形は、前後の句読点 (`(` `)` `,` `:` …) を外した形で見て除く。ticket /
ticket_hint もこの伏せた後の description から取るので、`Worker: <キー>` のような形でも秘密は出ない。
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
# 先頭の短縮 ID (bdboard-5iwh)。`<ID>: …` と `Implement|Fix <ID> …` の形。実在の確認は手順 B が bd show で行う。
HINT_RE = re.compile(r"^(?:(?i:implement|fix)\s+)?(?:bdboard-)?([a-z0-9]{3,6}(?:\.[0-9]+)*)(?=[:\s]|$)")
FIRST_WORD_RE = re.compile(r"^[a-z][a-z0-9._-]{0,23}$")
FIRST_WORD_MAX_DIGITS = 2  # 数字を 3 つ以上含む 1 語目 (sk-…123、xoxb-1234-…) は伏せる
SECOND_WORD_RE = re.compile(r"^(?:--[a-z][a-z-]{0,19}|-[A-Za-z]{1,3}|[a-z][a-z-]{0,19})$")
# 2 語目がサブコマンド名になる CLI。ここに無い 1 語目 (printf / echo / mysql …) の 2 語目は、フラグ形でなければ伏せる。
SUBCOMMAND_CLIS = frozenset(("aimix", "bd", "brew", "cargo", "docker", "gh", "git", "make", "npm", "npx", "pnpm",
                             "yarn"))  # claude / codex は 2 語目が自由なプロンプトになりうるので入れない
# description (meta.json) の語を伏せる条件。`bdboard-<ID>[.N]` の形だけは長くても出す。
LONG_MIXED_WORD_LENGTH = 16
TICKET_WORD_RE = re.compile(r"^bdboard-[a-z0-9]{3,6}(?:\.[0-9]+)*$")
TICKET_WORD_PUNCTUATION = "()[]{}<>:,;.'\""  # `bdboard-3tw.144:` / `(Worker: bdboard-cm2q.12)` の前後に付く記号
TOOL_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,59}$")
UNIT_SECONDS = {"ms": 0.001, "s": 1, "m": 60, "h": 3600}
USAGE_FIELDS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
PUBLIC_KEYS = ("agent_id", "agent_type", "model", "requested_model", "spawn_depth", "description", "hours", "first",
               "last", "tokens", "input_tokens", "cache_creation_input_tokens", "output_tokens", "turns",
               "incomplete_responses")
WORKER_KEYS = ("agent_id", "ticket", "ticket_hint", "description", "hours", "turns", "segments", "breakers", "resumes",
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


def first_word_shown(word):
    return FIRST_WORD_RE.fullmatch(word) is not None and sum(ch.isdigit() for ch in word) <= FIRST_WORD_MAX_DIGITS


def second_word_shown(first, word):
    """2 語目は語の形に合い、かつフラグ形か、サブコマンドを取る CLI の後ろか、CLI 名そのもののときだけ出す。
    `printf <値>` のように 1 語目が自由な引数を取るコマンドのとき、小文字だけの値をサブコマンド名と区別できない。"""
    if SECOND_WORD_RE.fullmatch(word) is None:
        return False
    return word.startswith("-") or first in SUBCOMMAND_CLIS or word in SUBCOMMAND_CLIS


def command_prefix(command):
    """拒否されたコマンドの先頭 2 語。許可リストに合う語だけ出し、それ以外は … にする (3 語目以降は出さない)。"""
    words = (command or "").split()[:2]
    if not words:
        return "(none)"
    first = words[0] if first_word_shown(words[0]) else MASK
    shown = [first]
    if len(words) > 1:
        shown.append(words[1] if second_word_shown(first, words[1]) else MASK)
    return " ".join(shown)


def redact_word(word):
    """description の ASCII の連なり 1 つ。URL・メール・NAME=値 (`://` / `@` / `=`) と、16 字以上で英字と数字が混ざる語を
    … にする。`bdboard-<ID>[.N]` の形は、前後の句読点 (`(`・`)`・`,`・`:` …) を外した形で見て、長くても出す。"""
    if "://" in word or "@" in word or "=" in word:
        return MASK
    mixed = len(word) >= LONG_MIXED_WORD_LENGTH and any(ch.isdigit() for ch in word) and any(ch.isalpha() for ch in word)
    return MASK if mixed and not TICKET_WORD_RE.fullmatch(word.strip(TICKET_WORD_PUNCTUATION)) else word


def redact_description(text):
    """空白区切りではなく ASCII の連なり (`[!-~]+`) ごとに見る。日本語の文字 (isalpha が真) が 16 字の数に入って、
    `v5.0.0アップグレード…` のような語が丸ごと伏せられないように。"""
    return re.sub(r"[!-~]+", lambda match: redact_word(match.group(0)), text)


def read_meta(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        value = None
    value = value if isinstance(value, dict) else {}
    depth = value.get("spawnDepth")
    # 伏せるのは 40 字に切る前。ticket / ticket_hint も伏せた後の本文から取る (`Worker: <キー>` の形で秘密を出さない)。
    description = redact_description(str(value.get("description") or ""))
    ticket = TICKET_RE.search(description)
    hint = None if ticket else HINT_RE.match(description.lstrip())
    return {"agent_type": value.get("agentType") or "unknown", "requested_model": value.get("model") or "unknown",
            "spawn_depth": depth if isinstance(depth, int) else None, "description": description[:40],
            "ticket": "bdboard-" + ticket.group(1) if ticket else None,
            "ticket_hint": "bdboard-" + hint.group(1) if hint else None}


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
                                 "with_ticket": sum(x["ticket"] is not None for x in workers),
                                 "with_ticket_hint": sum(x["ticket_hint"] is not None for x in workers),
                                 "without_ticket": sum(x["ticket"] is None and x["ticket_hint"] is None for x in workers),
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
              "M11 bdboard-worker continuations (v2): workers=%d max_segment=%d breakers=%d continuations=%d resumes=%d "
              "ticket=%d ticket_hint=%d no_ticket=%d" % (
                  cont["workers"], cont["max_segment"], cont["breakers"], cont["continuations"], cont["resumes"],
                  cont["with_ticket"], cont["with_ticket_hint"], cont["without_ticket"])]
    for item in cont["items"]:
        # ticket は Worker: から確定したもの、ticket_hint は先頭の短縮 ID (未確認。手順 B が bd show で確かめる)。
        lines.append('  %s ticket=%s%s turns=%d segments=%s breakers=%d continuations=%d ends_on_breaker=%s "%s"' % (
            item["agent_id"], item["ticket"] or "-", " ticket_hint=" + item["ticket_hint"] if item["ticket_hint"] else "",
            item["turns"], "+".join(str(n) for n in item["segments"]), item["breakers"], item["continuations"],
            "yes" if item["ends_on_breaker"] else "no", item["description"]))
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
