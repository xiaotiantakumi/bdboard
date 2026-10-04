import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// bdboard-eydu: scripts/harness-eval/transcript-metrics.py を、手で作った小さな合成 transcript
// (fixtures/transcripts。中身はすべて架空) に対して実行し、JSON と text の出力を固定する。
// python3 が PATH に無いときだけ丸ごと skip する (Python 側は標準ライブラリのみ)。
//
// 厳密一致のガード (is_error / Bash のみ / Permission の先頭一致 / 期間の両端を含む / 6 時間未満は null /
// mtime / tool_use の id 表を全行から作る) は、それぞれ単独で外すと落ちるように専用の行を fixture に持つ。
// 同じテストを変異させた複製に向けるときは TRANSCRIPT_METRICS_SCRIPT にそのパスを渡す。

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.TRANSCRIPT_METRICS_SCRIPT ?? path.join(HERE, 'transcript-metrics.py');
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'transcripts');

const PERIOD = ['--since', '2026-10-01T00:00:00Z', '--until', '2026-10-02T00:00:00Z'];

function hasPython3() {
  const r = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  return r.status === 0 && /^Python 3\./.test(`${r.stdout}${r.stderr}`);
}

function run(args, { dir = FIXTURE_DIR, env = {} } = {}) {
  return spawnSync('python3', [SCRIPT, '--dir', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1', ...env },
  });
}

function runJson(args, options) {
  const r = run([...args, '--format', 'json'], options);
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout);
}

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-metrics-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 合成 worker を 1 体書く。segmentSizes = 区切りごとの assistant 一意 id 数 (区切りの間に isMeta の再開行が入る)。
function writeSyntheticAgent(dir, agentId, agentType, segmentSizes, startHour) {
  const sub = path.join(dir, '00000000-0000-4000-8000-0000000000aa', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const base = Date.UTC(2026, 9, 1, startHour, 0, 0);
  let tick = 0;
  const stamp = () => new Date(base + tick++ * 1000).toISOString();
  const lines = [{ type: 'user', timestamp: stamp(), message: { role: 'user', content: 'synthetic brief' } }];
  segmentSizes.forEach((size, segment) => {
    if (segment > 0) {
      lines.push({
        type: 'user',
        isMeta: true,
        timestamp: stamp(),
        message: { role: 'user', content: 'The coordinator sent: synthetic resume' },
      });
    }
    for (let n = 0; n < size; n++) {
      lines.push({
        type: 'assistant',
        timestamp: stamp(),
        message: {
          id: `msg_${agentId}_${segment}_${n}`,
          model: 'claude-test-sub',
          role: 'assistant',
          content: [{ type: 'text', text: 'synthetic answer' }],
          usage: { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 },
        },
      });
    }
  });
  fs.writeFileSync(path.join(sub, `agent-${agentId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  fs.writeFileSync(
    path.join(sub, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType, description: `synthetic ${agentId}`, spawnDepth: 1, model: 'sonnet' }),
  );
}

describe.skipIf(!hasPython3())('transcript-metrics.py (bdboard-eydu)', () => {
  it('counts Bash timeouts, subagent time/tokens, denials and worker continuations in the period (json)', () => {
    const out = runJson(PERIOD);

    expect(out.period).toEqual({ since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z', hours: 24 });
    // 2 main sessions + 5 subagent transcripts, and the one line that is not JSON.
    expect(out.files).toEqual({ main: 2, subagent: 5, skipped_lines: 1 });

    // long (10m): main T1 (10m 0s) + main T5 (600s, list content) + subagent a1 (10m 0s) + B1 (its Bash
    // tool_use is before the period, so the id table must be built from every line).
    // short: 2m (T2) + 30s stamped exactly at --since (B2). unparsed: a Bash timeout with no duration.
    // Not counted: curl "Operation timed out", a Read result that merely quotes the text, a 10m timeout
    // before the period, the same sentence without is_error (N1), and from a non-Bash tool (N3).
    expect(out.bash_timeouts).toEqual({ long: 4, short: 2, unparsed: 1, long_per_24h: 4 });

    // Four subagents have lines in the period (a4 has none).
    expect(out.subagents.count).toBe(4);
    // a1 runs 02:00..05:30 inside the period; its 1,000,000-token turn before the period is ignored.
    expect(out.subagents.longest).toMatchObject({
      agent_id: 'a1',
      agent_type: 'bdboard-worker',
      model: 'claude-test-sub',
      requested_model: 'sonnet',
      spawn_depth: 1,
      description: 'Implement the synthetic alpha ticket for',
      hours: 3.5,
      first: '2026-10-01T02:00:00Z',
      last: '2026-10-01T05:30:00Z',
    });
    // tokens = input + cache_creation + output, and a LOWER BOUND (output_tokens may be a stream-start
    // snapshot, see below); cache_read is excluded. The three lines that share one message id (a1 msg_a1_1)
    // count once, with the largest value of each field (output 1/5/40 -> 40): 10+200+40, then msg_a1_2 20+300+100.
    expect(out.subagents.top_tokens.map((s) => [s.agent_id, s.tokens])).toEqual([
      ['a2', 2000],
      ['a1', 670],
      ['a5', 49],
      ['a3', 30],
    ]);
    expect(out.subagents.top_tokens[1]).toMatchObject({
      input_tokens: 30,
      cache_creation_input_tokens: 500,
      output_tokens: 140,
      turns: 2,
      incomplete_responses: 1,
    });
    // Grouped by the model that answered (message.model), not by the alias in meta.json: a1 ("sonnet") and
    // a5 ("claude-sonnet-5-5") merge; a3 has the same alias as a1 but a different answering model. a2's two
    // <synthetic> stubs do not decide its model.
    expect(out.subagents.by_type_model).toEqual([
      { agent_type: 'bdboard-worker', model: 'claude-test-sub', runs: 2, hours_total: 3.85, hours_max: 3.5, tokens_total: 719 },
      { agent_type: 'bdboard-worker', model: 'claude-test-sub-b', runs: 1, hours_total: 1.5, hours_max: 1.5, tokens_total: 30 },
      { agent_type: 'general-purpose', model: 'claude-test-sub', runs: 1, hours_total: 1, hours_max: 1, tokens_total: 2000 },
    ]);
    expect(out.subagents.top_tokens.map((s) => [s.agent_id, s.requested_model])).toEqual([
      ['a2', 'opus'],
      ['a1', 'sonnet'],
      ['a5', 'claude-sonnet-5-5'],
      ['a3', 'sonnet'],
    ]);
    // output_tokens is a lower bound: responses with no line that has stop_reason only have the stream-start
    // snapshot. a1 2 responses (1 without), a2 3 (0), a3 3 (3), a5 7 (4).
    expect(out.subagents.responses).toBe(15);
    expect(out.subagents.responses_without_final_usage).toBe(8);

    // permissions.deny: 12 in the period (4 plain, 1 at exactly --until, 7 masking cases). The classifier
    // refusal and the unparsed Permission text are counted apart. Only the first two words survive the
    // allowlist: URL userinfo, -pPASS, a quoted value, --token VALUE and token-like words become "…".
    expect(out.permission_denied).toEqual({
      deny: 12,
      deny_per_24h: 12,
      deny_unparsed: 1,
      classifier: 1,
      by_prefix: {
        'git stash': 2,
        'aimix run': 1,
        '… npm': 1,
        'git rebase': 1,
        'curl …': 1,
        'mysql …': 1,
        '… …': 2,
        'cli --token': 1,
        'echo …': 2,
      },
      by_tool: { Bash: 12 },
    });

    // v2: a1 / a3 have no resume. a5: a compaction summary, an early isMeta line, an isMeta line with a
    // tool_result and a back-to-back isMeta line do not split; the two real resumes do -> 4 + 2 + 1.
    expect(out.worker_continuations).toMatchObject({
      workers: 3,
      max_segment: 4,
      breakers: 0,
      continuations: 0,
      resumes: 2,
    });
    expect(out.worker_continuations.items.map((w) => [w.agent_id, w.ticket, w.turns, w.segments])).toEqual([
      ['a1', null, 2, [2]],
      ['a3', null, 3, [3]],
      ['a5', 'bdboard-ab12', 7, [4, 2, 1]],
    ]);
    expect(out.worker_continuations.items[2]).toMatchObject({
      description: 'Worker: ab12 再開の合成ケース',
      breakers: 0,
      resumes: 2,
      continuations: 0,
      ends_on_breaker: false,
    });
  });

  it('prints one line per metric in text, says lower bound, and leaks neither prompts nor secrets', () => {
    const r = run([...PERIOD]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('M6 bash_timeouts: long=4');
    expect(r.stdout).toContain('M7 subagents: 4 runs');
    expect(r.stdout).toContain('responses=15 without_final_usage=8: output_tokens and tokens are a lower bound');
    expect(r.stdout).toContain('tokens top5 (lower bound;');
    expect(r.stdout).toContain('tokens>=2000');
    expect(r.stdout).toContain('M10 permission_denied: deny=12');
    expect(r.stdout).toContain('deny_unparsed=1');
    expect(r.stdout).toContain('M11 bdboard-worker continuations (v2): workers=3 max_segment=4 breakers=0 continuations=0 resumes=2');
    expect(r.stdout).toContain('a5 ticket=bdboard-ab12 turns=7 segments=4+2+1');
    expect(r.stdout).not.toContain('M12');
    expect(r.stdout).not.toContain('synthetic prompt');
    for (const secret of [
      'example-value',
      'example-user',
      'example-password',
      'EXAMPLEPASS',
      'EXAMPLEVALUE',
      'sk-EXAMPLE',
      'abcdefghijklmnopqrstuvwxyz',
    ]) {
      expect(r.stdout).not.toContain(secret);
    }
  });

  it('counts nothing outside the period', () => {
    const out = runJson(['--since', '2026-10-02T00:00:01Z', '--until', '2026-10-03T00:00:00Z']);
    expect(out.bash_timeouts).toMatchObject({ long: 0, short: 0 });
    expect(out.subagents).toMatchObject({ count: 0, longest: null, top_tokens: [], by_type_model: [] });
    expect(out.permission_denied).toMatchObject({ deny: 0, deny_unparsed: 0, classifier: 0, by_prefix: {} });
    expect(out.worker_continuations).toMatchObject({ workers: 0, max_segment: 0, breakers: 0, continuations: 0, items: [] });
  });

  it('includes entries stamped exactly at --since and exactly at --until', () => {
    // B2: a 30s Bash timeout stamped 2026-10-01T00:00:00Z.
    const atSince = runJson(['--since', '2026-10-01T00:00:00Z', '--until', '2026-10-01T00:00:00Z']);
    expect(atSince.bash_timeouts).toMatchObject({ long: 0, short: 1 });
    // D6: a denial stamped 2026-10-02T00:00:00Z.
    const atUntil = runJson(['--since', '2026-10-02T00:00:00Z', '--until', '2026-10-02T00:00:00Z']);
    expect(atUntil.permission_denied).toMatchObject({ deny: 1, by_prefix: { 'git rebase': 1 } });
    expect(atUntil.bash_timeouts).toMatchObject({ long: 0, short: 0 });
  });

  it('gives per-24h values only for a period of 6 hours or more', () => {
    const fiveHours = runJson(['--since', '2026-10-01T00:00:00Z', '--until', '2026-10-01T05:00:00Z']);
    expect(fiveHours.period.hours).toBe(5);
    expect(fiveHours.bash_timeouts.long_per_24h).toBeNull();
    expect(fiveHours.permission_denied.deny_per_24h).toBeNull();

    // 00:00..06:00: long = B1, T1, T5, a1 -> 4 * 24 / 6; deny = D1..D4 + 7 masking cases -> 11 * 24 / 6.
    const sixHours = runJson(['--since', '2026-10-01T00:00:00Z', '--until', '2026-10-01T06:00:00Z']);
    expect(sixHours.period.hours).toBe(6);
    expect(sixHours.bash_timeouts).toMatchObject({ long: 4, long_per_24h: 16 });
    expect(sixHours.permission_denied).toMatchObject({ deny: 11, deny_per_24h: 44 });

    // Without --since there is no period length to convert with.
    const noSince = runJson(['--until', '2026-10-02T00:00:00Z']);
    expect(noSince.period.hours).toBeNull();
    expect(noSince.bash_timeouts.long_per_24h).toBeNull();
    expect(noSince.permission_denied.deny_per_24h).toBeNull();
  });

  it('rejects --since after --until with exit code 2', () => {
    const r = run(['--since', '2026-10-02T00:00:01Z', '--until', '2026-10-02T00:00:00Z']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--since');
  });

  it('treats a timestamp without a zone as UTC', () => {
    const zoned = runJson(PERIOD);
    const naive = runJson(['--since', '2026-10-01T00:00:00', '--until', '2026-10-02T00:00:00']);
    expect(naive).toEqual(zoned);
    const dateOnly = runJson(['--since', '2026-10-01', '--until', '2026-10-02']);
    expect(dateOnly).toEqual(zoned);
  });

  it('skips files whose mtime is older than --since (and reads them without --since)', () => {
    withTmpDir((dir) => {
      fs.cpSync(FIXTURE_DIR, dir, { recursive: true });
      const now = new Date();
      const old = new Date('2020-01-01T00:00:00Z');
      const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) walk(full);
          else fs.utimesSync(full, now, entry.name === 'agent-a2.jsonl' ? old : now);
        }
      };
      walk(dir);

      const filtered = runJson(PERIOD, { dir });
      expect(filtered.files.subagent).toBe(4);
      expect(filtered.subagents.count).toBe(3);
      expect(filtered.subagents.top_tokens.map((s) => s.agent_id)).toEqual(['a1', 'a5', 'a3']);

      const unfiltered = runJson(['--until', '2026-10-02T00:00:00Z'], { dir });
      expect(unfiltered.files.subagent).toBe(5);
    });
  });

  it('counts breakers (80 unique ids) and the resumes that follow them, for workers only', () => {
    withTmpDir((dir) => {
      // w1: 80 (breaker) -> resume -> 79 (not a breaker) -> resume -> 80 (breaker) -> resume -> 1.
      writeSyntheticAgent(dir, 'w1', 'bdboard-worker', [80, 79, 80, 1], 12);
      // w2: ends on the breaker with no resume.
      writeSyntheticAgent(dir, 'w2', 'bdboard-worker', [80], 14);
      // w3: a resume after the breaker that has no answer yet (the segment after it is 0).
      writeSyntheticAgent(dir, 'w3', 'bdboard-worker', [80, 0], 16);
      // w4: not a worker, so it is not part of M11.
      writeSyntheticAgent(dir, 'w4', 'general-purpose', [80], 18);

      const out = runJson(PERIOD, { dir });
      expect(out.worker_continuations).toMatchObject({
        workers: 3,
        max_segment: 80,
        breakers: 4,
        continuations: 3,
        resumes: 4,
      });
      expect(
        out.worker_continuations.items.map((w) => [
          w.agent_id,
          w.turns,
          w.segments,
          w.breakers,
          w.resumes,
          w.continuations,
          w.ends_on_breaker,
        ]),
      ).toEqual([
        ['w1', 240, [80, 79, 80, 1], 2, 3, 2, false],
        ['w2', 80, [80], 1, 0, 0, true],
        ['w3', 80, [80, 0], 1, 1, 1, false],
      ]);
    });
  });

  it('writes UTF-8 to stdout even when the console encoding is ASCII', () => {
    const r = run([...PERIOD], { env: { PYTHONUTF8: '0', PYTHONIOENCODING: 'ascii' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('再開の合成ケース');
  });
});
