// bdboard-ulxa.1: merge-pr*.test.mjs 共有の gh / bd / npm の代役。
//
// `node fake-tools.mjs <gh|bd|npm> ...args` として起動される (BDBOARD_MERGE_GH 等の JSON 配列経由。
// PATH にもシェバンにも依存しない — scripts/fake-gh.mjs と同じ理由)。状態は
// BDBOARD_MERGE_FAKE_STATE の JSON ファイルに置き、呼び出しのたびに読み書きする:
//   pulls[n]            gh api repos/R/pulls/n の応答 (REST の形)
//   checks[n]           gh pr checks n --required の終了コード (既定 0)。--json のときは行 (checksRows の既定) に直し、終了コードは 0
//   checksRows[n]       あれば gh pr checks n の行 [{ name, state, bucket, link }] (bdboard-bsc3。cancel の再現)。表形式の終了コードは gh の規則 (fail=1 / pending=8 / 他=0)
//   checksJsonUnsupported  true なら gh pr checks --json は "unknown flag" で exit 1 (--json を持たない古い gh)
//   statuses[sha]       gh api repos/R/commits/sha/status の statuses 配列
//   bdShow[id]          bd show の応答。'not-found' / 'unreachable' / 'bad-json' は異常系 sentinel
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

// bdboard-bsc3: gh pr checks の行 ({ name, state, bucket, link })。checksRows[n] があればそれ、
// 無ければ checks[n] (終了コード) から作る。bucket は gh の aggregateChecks と同じ綴り
// (pass / fail / pending / skipping / cancel)。
function checkRows(pr) {
  const rows = state.checksRows?.[pr];
  if (Array.isArray(rows)) {
    return rows;
  }
  const exit = state.checks?.[pr] ?? 0;
  if (exit === 0) {
    return [
      { name: 'verify', state: 'SUCCESS', bucket: 'pass', link: 'https://github.com/example/demo/actions/runs/1001/job/2001' },
      { name: 'e2e', state: 'SUCCESS', bucket: 'pass', link: 'https://github.com/example/demo/actions/runs/1001/job/2002' },
    ];
  }
  const kind = exit === 8 ? { state: 'IN_PROGRESS', bucket: 'pending' } : { state: 'FAILURE', bucket: 'fail' };
  return [{ name: 'verify', ...kind, link: 'https://github.com/example/demo/actions/runs/1001/job/2001' }];
}

function checks() {
  const pr = args[2];
  if (state.checksError?.[pr]) {
    err = `${state.checksError[pr]}\n`;
    code = 1;
    return;
  }
  const rows = checkRows(pr);
  if (args.includes('--json')) {
    if (state.checksJsonUnsupported) {
      err = 'unknown flag: --json\n';
      code = 1;
      return;
    }
    // 本物の gh は --json のとき、チェックが fail / pending でも終了コード 0 で JSON を書いて終わる
    // (checksRun は Exporter.Write を、終了コードを決める counts.Failed / Pending の判定より先に返す。
    // cli/cli v2.86.0 pkg/cmd/pr/checks/checks.go)。終了コードで判定していた旧 requiredChecks が、cancel を pass に倒した。
    out = JSON.stringify(rows.map(({ name, state: rowState, bucket, link }) => ({ name, state: rowState, bucket, link })));
    return;
  }
  if (Array.isArray(state.checksRows?.[pr])) {
    // 表形式: 本物の gh と同じく fail があれば 1、無ければ pending があれば 8。cancel は数えない (cancel だけなら 0)。
    out = rows.map((row) => `${row.name}\t${row.bucket}\t0\t${row.link}\t\n`).join('');
    code = rows.some((row) => row.bucket === 'fail') ? 1 : rows.some((row) => row.bucket === 'pending') ? 8 : 0;
    return;
  }
  code = state.checks?.[pr] ?? 0;
  out = code === 0 ? 'verify\tpass\ne2e\tpass\n' : 'verify\tpending\n';
}

function gh() {
  if (args[0] === 'pr' && args[1] === 'checks') {
    checks();
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
    } else if (shown === 'not-found') {
      err = 'Error: no issues found\n';
      code = 1;
    } else if (shown === 'unreachable') {
      err = 'Error: failed to open database: dolt server unreachable\n';
      code = 1;
    } else if (shown === 'bad-json') {
      out = 'not json\n';
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
