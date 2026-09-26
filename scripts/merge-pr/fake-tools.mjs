// bdboard-ulxa.1: merge-pr.test.mjs 専用の gh / bd / npm の代役。
//
// `node fake-tools.mjs <gh|bd|npm> ...args` として起動される (BDBOARD_MERGE_GH 等の JSON 配列経由。
// PATH にもシェバンにも依存しない — scripts/fake-gh.mjs と同じ理由)。状態は
// BDBOARD_MERGE_FAKE_STATE の JSON ファイルに置き、呼び出しのたびに読み書きする:
//   pulls[n]            gh api repos/R/pulls/n の応答 (REST の形)
//   checks[n]           gh pr checks n --required の終了コード (既定 0)
//   statuses[sha]       gh api repos/R/commits/sha/status の statuses 配列
//   statusQueue[sha]    あれば GET のたびに先頭を取り出して statuses[sha] に据える (待ちの再現)
//   checksError[n]      あれば gh pr checks n がこの stderr で exit 1 (API エラーの再現)
//   slot                { holder, freeAfter, onAcquire, broken } — bd merge-slot の代役
//   npmExit             npm の終了コード
//   calls / posted      呼び出しと POST された status の記録 (テストが検証する)
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const statePath = process.env.BDBOARD_MERGE_FAKE_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const [tool, ...args] = process.argv.slice(2);
state.calls = [...(state.calls ?? []), [tool, ...args]];

let out = '';
let err = '';
let code = 0;

function flagValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function gh() {
  if (args[0] === 'pr' && args[1] === 'checks' && state.checksError?.[args[2]]) {
    err = `${state.checksError[args[2]]}\n`;
    code = 1;
    return;
  }
  if (args[0] === 'pr' && args[1] === 'checks') {
    code = state.checks?.[args[2]] ?? 0;
    out = code === 0 ? 'verify\tpass\ne2e\tpass\n' : 'verify\tpending\n';
    return;
  }
  if (args[0] !== 'api') {
    err = `fake gh: unsupported ${args.join(' ')}`;
    code = 2;
    return;
  }
  const endpoint = args.find((arg) => arg.startsWith('repos/'));
  let match = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(endpoint);
  if (match) {
    const pull = state.pulls?.[match[1]];
    if (pull === undefined) {
      err = 'HTTP 404: Not Found';
      code = 1;
    } else {
      out = JSON.stringify(pull);
    }
    return;
  }
  match = /^repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)\/status$/.exec(endpoint);
  if (match) {
    const sha = match[1];
    const queue = state.statusQueue?.[sha];
    if (Array.isArray(queue) && queue.length > 0) {
      state.statuses = { ...state.statuses, [sha]: queue.shift() };
    }
    out = JSON.stringify({ sha, statuses: state.statuses?.[sha] ?? [] });
    return;
  }
  match = /^repos\/[^/]+\/[^/]+\/statuses\/([0-9a-f]+)$/.exec(endpoint);
  if (match && args.includes('POST')) {
    const fields = Object.fromEntries(
      args.filter((_, i) => args[i - 1] === '-f').map((field) => [field.slice(0, field.indexOf('=')), field.slice(field.indexOf('=') + 1)]),
    );
    const entry = { ...fields, updated_at: new Date().toISOString() };
    state.posted = [...(state.posted ?? []), { sha: match[1], ...fields }];
    const others = (state.statuses?.[match[1]] ?? []).filter((s) => s.context !== fields.context);
    state.statuses = { ...state.statuses, [match[1]]: [entry, ...others] };
    out = JSON.stringify(entry);
    return;
  }
  err = `fake gh: unsupported api ${endpoint}`;
  code = 2;
}

function bd() {
  if (args[0] === 'show' && args[2] === '--json') {
    const shown = state.bdShow?.[args[1]];
    if (shown === undefined) {
      err = `Error: issue ${args[1]} not found\n`;
      code = 1;
    } else {
      out = JSON.stringify(shown);
    }
    return;
  }
  const slot = state.slot ?? { holder: null };
  state.slot = slot;
  const sub = args[1];
  const holder = flagValue('--holder');
  if (slot.broken) {
    err = 'Error: failed to open database: dolt server unreachable\n';
    code = 1;
  } else if (sub === 'check') {
    out = JSON.stringify({ available: slot.holder === null, holder: slot.holder, id: 'demo-merge-slot', waiters: [] });
  } else if (sub === 'acquire') {
    if (slot.holder !== null && slot.holder !== undefined) {
      if (typeof slot.freeAfter === 'number' && --slot.freeAfter <= 0) {
        slot.holder = null;
      }
      err = `Error: slot held by: ${slot.holder ?? '(just released)'}\n`;
      code = 1;
    } else {
      slot.holder = holder;
      if (Array.isArray(slot.onAcquire)) {
        spawnSync(slot.onAcquire[0], slot.onAcquire.slice(1), { stdio: 'ignore' });
        slot.onAcquire = null;
      }
      out = `Acquired merge slot: demo-merge-slot (holder: ${holder})\n`;
    }
  } else if (sub === 'release') {
    if (slot.holder !== holder) {
      err = `Error: slot held by ${slot.holder}, not ${holder}\n`;
      code = 1;
    } else {
      slot.holder = null;
      out = 'Released merge slot\n';
    }
  } else {
    err = `fake bd: unsupported ${args.join(' ')}`;
    code = 2;
  }
}

if (tool === 'gh') {
  gh();
} else if (tool === 'bd') {
  bd();
} else if (tool === 'npm') {
  code = state.npmExit ?? 0;
} else {
  err = `fake-tools: unknown tool ${tool}`;
  code = 2;
}

writeFileSync(statePath, JSON.stringify(state, null, 2));
// process.exit() は Windows の pipe で出力を切り詰めうる (scripts/fake-cli.mjs と同じ理由)。
process.stdout.write(out);
process.stderr.write(err);
process.exitCode = code;
