import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// bdboard-eydu: scripts/harness-eval/transcript-metrics.py を、手で作った小さな合成 transcript
// (fixtures/transcripts。中身はすべて架空) に対して実行し、JSON と text の出力を固定する。
// python3 が無い環境 (Windows の CI など) では丸ごと skip する。

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'transcript-metrics.py');
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'transcripts');

const PERIOD = ['--since', '2026-10-01T00:00:00Z', '--until', '2026-10-02T00:00:00Z'];

function hasPython3() {
  const r = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  return r.status === 0 && /^Python 3\./.test(`${r.stdout}${r.stderr}`);
}

function run(args) {
  return spawnSync('python3', [SCRIPT, '--dir', FIXTURE_DIR, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1' },
  });
}

describe.skipIf(!hasPython3())('transcript-metrics.py (bdboard-eydu)', () => {
  it('counts Bash timeouts, subagent time/tokens and permission denials in the period (json)', () => {
    const r = run([...PERIOD, '--format', 'json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);

    expect(out.period).toEqual({ since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z', hours: 24 });
    // 2 main sessions + 4 subagent transcripts, and the one line that is not JSON.
    expect(out.files).toEqual({ main: 2, subagent: 4, skipped_lines: 1 });

    // 10m: main T1 (10m 0s) + main T5 (600s, list content) + subagent a1 (10m 0s).
    // Not counted: 2m (short), curl "Operation timed out", a Read result that merely quotes the text,
    // and a 10m timeout before the period. A Bash "Command timed out after" without a duration is `unparsed`.
    expect(out.bash_timeouts).toEqual({ long: 3, short: 1, unparsed: 1, long_per_24h: 3 });

    expect(out.subagents.count).toBe(3);
    // a1 runs 02:00..05:30 inside the period; its 1,000,000-token turn before the period is ignored.
    expect(out.subagents.longest).toMatchObject({
      agent_id: 'a1',
      agent_type: 'bdboard-worker',
      model: 'sonnet',
      spawn_depth: 1,
      description: 'Implement the synthetic alpha ticket for',
      hours: 3.5,
      first: '2026-10-01T02:00:00Z',
      last: '2026-10-01T05:30:00Z',
    });
    // tokens = input + cache_creation + output; cache_read is excluded, and the three entries that
    // share one message id (a1 msg_a1_1) count once with the final output_tokens (10+200+40, 20+300+100).
    expect(out.subagents.top_tokens.map((s) => [s.agent_id, s.tokens])).toEqual([
      ['a2', 2000],
      ['a1', 670],
      ['a3', 30],
    ]);
    expect(out.subagents.top_tokens[1]).toMatchObject({
      input_tokens: 30,
      cache_creation_input_tokens: 500,
      output_tokens: 140,
      turns: 2,
    });
    expect(out.subagents.by_type_model).toEqual([
      { agent_type: 'bdboard-worker', model: 'sonnet', runs: 2, hours_total: 5, hours_max: 3.5, tokens_total: 700 },
      { agent_type: 'general-purpose', model: 'opus', runs: 1, hours_total: 1, hours_max: 1, tokens_total: 2000 },
    ]);

    // permissions.deny: 4 in the period. The classifier refusal is counted apart. Only the first two
    // words are kept, and the value of an env assignment is dropped.
    expect(out.permission_denied).toEqual({
      deny: 4,
      deny_per_24h: 4,
      classifier: 1,
      by_prefix: { 'git stash': 2, 'aimix run': 1, 'EXAMPLE_VAR=… npm': 1 },
      by_tool: { Bash: 4 },
    });

    // a3 answered 3 times; a4 is a worker too but has nothing in the period.
    expect(out.worker_turns).toEqual({ workers: 2, max: 3, ge64: 0 });
    // Only user text counts (string or text blocks): 2 in session 1, 1 in session 2.
    expect(out.stop_gate_nudges).toEqual({ max_per_transcript: 2, total: 3, transcripts: 2 });
  });

  it('prints one line per metric in text and leaks neither prompts nor command arguments', () => {
    const r = run([...PERIOD]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('M6 bash_timeouts: long=3');
    expect(r.stdout).toContain('M7 subagents: 3 runs');
    expect(r.stdout).toContain('M10 permission_denied: deny=4');
    expect(r.stdout).toContain('M11 bdboard-worker turns: workers=2 max=3');
    expect(r.stdout).toContain('M12 stop-ticket-gate nudges: max_per_transcript=2 total=3');
    expect(r.stdout).not.toContain('synthetic prompt');
    expect(r.stdout).not.toContain('example-value');
  });

  it('counts nothing outside the period', () => {
    const r = run(['--since', '2026-10-02T00:00:00Z', '--until', '2026-10-03T00:00:00Z', '--format', 'json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.bash_timeouts).toMatchObject({ long: 0, short: 0 });
    expect(out.subagents).toMatchObject({ count: 0, longest: null, top_tokens: [], by_type_model: [] });
    expect(out.permission_denied).toMatchObject({ deny: 0, classifier: 0, by_prefix: {} });
    expect(out.stop_gate_nudges).toEqual({ max_per_transcript: 0, total: 0, transcripts: 0 });
  });
});
