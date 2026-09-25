// bdboard-ulxa.6: マージ手順 S2 の「着地予定ツリーの verify のやり直し」を、実際の負荷をかけずに
// 比べる離散時間シミュレーション。`node scripts/verify-slot-sim.mjs` で表を出し、
// verify-slot-sim.test.mjs が同じ関数で「並列 7 本でやり直しが減る」ことを固定する。
//
// スロットの順番は本物の関数で決める: 旧手順は verify-slot-queue.mjs の legacyRank (bdboard-d48 の
// FIFO と同じ計算)、新手順は planSlots (優先度 + 仮想到着時刻)。merge-pr 側の振る舞い
// (main が動いたら verify をやめる / 並び直しても最初に並んだ時刻を引き継ぐ) は下の policy で表す。
//
// モデル (1 刻み = tickSecs 秒。数値は 2026-09-24〜25 の監査ログからの目安):
//   エージェント n 人がそれぞれ チケット実装 (15〜40 分) → PR 前の手元 verify (priority pr) →
//   CI (ciSecs) → prepare: その時点の main の上の着地予定ツリーを verify (priority merge) →
//   終わった時点で main が同じなら gate: PRED_BASE の着地後検証 success を待ち、CAS してマージ →
//   finish: 新しい main の着地後検証 (priority landed) → 次のチケット。
//   main が動いていたら (verify の後、または gate の CAS で) reactSecs 後に prepare からやり直す。
//   verify 1 本は verifySecs ±15%。スロットは slots 本。
import { fileURLToPath } from 'node:url';

import { legacyRank, MAX_SENIORITY_MS, planSlots, TIER_STEP_MS } from './verify-slot-queue.mjs';

const MIN = 60_000;

export const POLICIES = Object.freeze({
  /** 変更前: FIFO (旧 verify-slot)、使えなくなった verify も最後まで走らせる。 */
  before: { legacy: true },
  /** 優先度だけ (議長案の順: merge > pr > landed)。 */
  priorityChairOrder: { order: { merge: 'landed', pr: 'merge', landed: 'pr' } },
  /** 優先度だけ (landed > merge > pr)。 */
  priorityOnly: {},
  /** FIFO のまま、使えなくなった verify をやめるだけ。 */
  abandonOnly: { legacy: true, abandon: true },
  /** 採用案: 優先度 (landed > merge > pr) + やめる + 最初に並んだ時刻の引き継ぎ。 */
  after: { abandon: true, seniority: true },
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const QUEUE_OPTIONS = { slots: 2, staleTtlMs: 30 * MIN, tierStepMs: TIER_STEP_MS, maxSeniorityMs: MAX_SENIORITY_MS };

export function simulate(policy, { seed = 1, agents = 7, hours = 8, slots = 2, verifySecs = 330, ciSecs = 480, reactSecs = 30, pollSecs = 30, tickSecs = 5 } = {}) {
  const random = mulberry32(seed);
  const order = policy.order ?? { merge: 'merge', pr: 'pr', landed: 'landed' };
  const queueOptions = { ...QUEUE_OPTIONS, slots };
  const stats = { merges: 0, predictedRuns: 0, wastedRuns: 0, abandonedInQueue: 0, redo: [], latency: [], prWait: [], maxRunning: 0 };
  let now = 0;
  let main = 0;
  let nextPid = 1;
  const landedOk = new Set([0]);
  const jobs = [];
  const enqueue = (kind, agent, extra = {}) => {
    const job = { kind, agent, pid: nextPid++, joinedAt: now, priority: order[kind], ...extra };
    if (!policy.legacy) {
      job.v = 2;
    }
    jobs.push(job);
    return job;
  };
  const drop = (job) => jobs.splice(jobs.indexOf(job), 1);
  const retry = (agent) => {
    agent.redo += 1;
    agent.phase = 'react';
    agent.until = now + reactSecs * 1000;
  };
  const startPrepare = (agent) => {
    agent.firstPrepareAt ??= now;
    agent.phase = 'predicted';
    enqueue('merge', agent, { base: main, ...(policy.seniority ? { since: agent.firstPrepareAt } : {}) });
  };
  const agentList = Array.from({ length: agents }, (_, index) => ({ index, phase: 'implement', until: Math.round(random() * 40 * MIN), redo: 0 }));

  const isRunning = (job) => (policy.legacy ? legacyRank(job, jobs, now, queueOptions.staleTtlMs) < slots : job.acquiredAt !== undefined);
  const schedule = () => {
    for (const job of jobs) {
      if (job.startedAt !== undefined) {
        continue;
      }
      const go = policy.legacy ? isRunning(job) : planSlots(jobs, { ...queueOptions, selfPid: job.pid, now }).acquire;
      if (go) {
        job.acquiredAt = policy.legacy ? undefined : now;
        job.startedAt = now;
        job.endAt = now + Math.round(verifySecs * 1000 * (0.85 + 0.3 * random()));
        stats.predictedRuns += job.kind === 'merge' ? 1 : 0;
        if (job.kind === 'pr') {
          stats.prWait.push(now - job.joinedAt);
        }
      }
    }
    stats.maxRunning = Math.max(stats.maxRunning, jobs.filter((job) => job.startedAt !== undefined).length);
  };

  const finishJob = (job) => {
    drop(job);
    const agent = job.agent;
    if (job.kind === 'landed') {
      landedOk.add(job.sha);
    } else if (job.kind === 'pr') {
      agent.phase = 'ci';
      agent.until = now + ciSecs * 1000;
    } else if (job.base !== main) {
      stats.wastedRuns += 1;
      retry(agent);
    } else {
      agent.phase = 'gate';
      agent.base = job.base;
    }
  };

  const stepAgent = (agent) => {
    if (agent.phase === 'implement' && now >= agent.until) {
      agent.phase = 'prVerify';
      enqueue('pr', agent);
    } else if ((agent.phase === 'ci' || agent.phase === 'react') && now >= agent.until) {
      startPrepare(agent);
    } else if (agent.phase === 'gate' && agent.base !== main) {
      retry(agent); // CAS 負け
    } else if (agent.phase === 'gate' && landedOk.has(agent.base)) {
      main += 1;
      stats.merges += 1;
      stats.redo.push(agent.redo);
      stats.latency.push(now - agent.firstPrepareAt);
      enqueue('landed', agent, { sha: main });
      Object.assign(agent, { phase: 'implement', until: now + Math.round((15 + 25 * random()) * MIN), redo: 0, firstPrepareAt: undefined });
    }
  };

  for (; now < hours * 60 * MIN; now += tickSecs * 1000) {
    for (const job of jobs.filter((entry) => entry.startedAt !== undefined && now >= entry.endAt)) {
      finishJob(job);
    }
    if (policy.abandon && now % (pollSecs * 1000) === 0) {
      for (const job of jobs.filter((entry) => entry.kind === 'merge' && entry.base !== main)) {
        drop(job);
        stats[job.startedAt === undefined ? 'abandonedInQueue' : 'wastedRuns'] += 1;
        retry(job.agent);
      }
    }
    agentList.forEach(stepAgent);
    schedule();
  }
  return summarize(stats);
}

function summarize(stats) {
  const mean = (values) => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);
  const max = (values) => (values.length === 0 ? 0 : Math.max(...values));
  const round1 = (value) => Math.round(value * 10) / 10;
  return {
    merges: stats.merges,
    predictedRuns: stats.predictedRuns,
    wastedRuns: stats.wastedRuns,
    wastedPerMerge: round1(stats.wastedRuns / Math.max(1, stats.merges)),
    redoMean: round1(mean(stats.redo)),
    redoMax: max(stats.redo),
    latencyMeanMin: round1(mean(stats.latency) / MIN),
    latencyMaxMin: round1(max(stats.latency) / MIN),
    prWaitMeanMin: round1(mean(stats.prWait) / MIN),
    prWaitMaxMin: round1(max(stats.prWait) / MIN),
    maxRunning: stats.maxRunning,
  };
}

/** seeds 本の平均 (max 系は最大) をとる。 */
export function simulateSeeds(policy, seeds, options = {}) {
  const runs = seeds.map((seed) => simulate(policy, { ...options, seed }));
  const merged = {};
  for (const key of Object.keys(runs[0])) {
    const values = runs.map((run) => run[key]);
    merged[key] = /Max|maxRunning/.test(key) ? Math.max(...values) : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
  }
  return merged;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  console.log(`agents=7 slots=2 verify≈330s CI=8min, 8h × seeds ${seeds.join(',')} (平均。*Max と maxRunning は最大)`);
  for (const [name, policy] of Object.entries(POLICIES)) {
    console.log(name.padEnd(20), JSON.stringify(simulateSeeds(policy, seeds)));
  }
}
