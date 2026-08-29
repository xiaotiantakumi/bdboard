import { describe, expect, it } from 'vitest';
import { NodeStreamingCommandRunner } from './node-streaming-command-runner.js';

describe('NodeStreamingCommandRunner', () => {
  const runner = new NodeStreamingCommandRunner();

  /**
   * 子プロセスが自分で書いた pid を読む(bdboard-dvt)。
   *
   * kill 系のテストは「子が pid を書き終える前に kill されない」ことに
   * 暗黙に依存している。そこが崩れたときに `Number('')` = 0 が下流へ流れて
   * 「expected 0 to be greater than 0」や「process 0 is still alive」という
   * 原因の分からない失敗になるので、ここで理由を添えて落とす。
   */
  function parsePid(stdout: string, label: string): number {
    expect(
      stdout,
      `${label}: 子プロセスが pid を書く前に kill された可能性がある(起動が遅い?)`,
    ).not.toBe('');
    const pid = Number(stdout);
    expect(Number.isInteger(pid), `${label}: pid として読めない出力: ${stdout}`).toBe(true);
    expect(pid).toBeGreaterThan(0);
    return pid;
  }

  async function expectProcessToBeGone(pid: number): Promise<void> {
    // pid 0 は「自分のプロセスグループ全体」を指す。signal 0 は配送されない
    // ので実害は無いが、kill が投げないぶん 200ms 待って的外れなメッセージで
    // 落ちるだけになるので、ここで弾く。
    expect(pid, 'pid 0 をプロセス存在確認に渡してはいけない').toBeGreaterThan(0);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`child process ${pid} is still alive`);
  }

  it('delivers stdout chunks in order and retains the complete output', async () => {
    const chunks: string[] = [];
    const result = await runner.run(
      process.execPath,
      [
        '-e',
        // 2回の write の間隔(bdboard-dvt): 親のイベントループがこの間隔より
        // 長く詰まると、両方がパイプに溜まって1チャンクとして読まれ、
        // chunks.length >= 2 が偽になる。負荷の高いマシンでの取りこぼしを
        // 避けるため、ストリーミングを示すのに必要な最小値より広く取る。
        "process.stdout.write('first'); setTimeout(() => process.stdout.write('second'), 100)",
      ],
      { onChunk: (chunk) => chunks.push(chunk.text) },
    );

    expect(result.exitCode).toBe(0);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join('')).toBe('firstsecond');
    expect(result.stdout).toBe(chunks.join(''));
  });

  it('writes input to child stdin', async () => {
    const result = await runner.run(
      process.execPath,
      ['-e', "process.stdout.write(require('fs').readFileSync(0, 'utf8'))"],
      { input: 'hello-from-stdin', onChunk: () => {} },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello-from-stdin');
  });

  it('closes stdin immediately when input is omitted so stdin-waiting children do not hang', async () => {
    const childScript =
      "let data='';" +
      "process.stdin.on('data', (chunk) => { data += chunk; });" +
      "process.stdin.on('end', () => { process.stdout.write('done:' + data); });";

    const start = Date.now();
    const result = await runner.run(process.execPath, ['-e', childScript], {
      timeoutMs: 2_000,
      onChunk: () => {},
    });
    const elapsedMs = Date.now() - start;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('done:');
    expect(result.failureKind).toBeUndefined();
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('replaces env without inheriting the parent environment', async () => {
    const previous = process.env.BDBOARD_STREAMING_TEST_VAR;
    process.env.BDBOARD_STREAMING_TEST_VAR = 'from-parent';

    try {
      const result = await runner.run(
        process.execPath,
        ['-e', 'process.stdout.write(String(process.env.BDBOARD_STREAMING_TEST_VAR ?? "missing"))'],
        { env: {}, onChunk: () => {} },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('missing');
    } finally {
      if (previous === undefined) {
        delete process.env.BDBOARD_STREAMING_TEST_VAR;
      } else {
        process.env.BDBOARD_STREAMING_TEST_VAR = previous;
      }
    }
  });

  it('terminates the child on timeout and waits for it to exit', async () => {
    const result = await runner.run(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.pid)); setInterval(() => {}, 10_000)'],
      // timeoutMs は run() を呼んだ時点から測り始めるので、この予算は
      // 子プロセスの起動 + pid の write + 親の読み取りを全部含む
      // (bdboard-dvt)。実測では 20ms 前後だが、負荷の高いマシンでは伸びる。
      // このテストの主題は kill の挙動であってタイムアウトの精度ではないので、
      // 予算は余裕を持って取る。
      { timeoutMs: 1_000, onChunk: () => {} },
    );

    expect(result.failureKind).toBe('timeout');
    await expectProcessToBeGone(parsePid(result.stdout, 'timeout'));
  });

  it('terminates the child on abort and waits for it to exit', async () => {
    const controller = new AbortController();
    // 固定待ちで abort すると「子が pid を書く前に abort する」競合が残る
    // (bdboard-dvt)。最初のチャンク = pid が届いたことを合図に abort すれば、
    // 順序が保証されるうえ待ち時間も無くなる。
    const result = await runner.run(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.pid)); setInterval(() => {}, 10_000)'],
      { signal: controller.signal, onChunk: () => controller.abort() },
    );

    expect(result.failureKind).toBe('aborted');
    await expectProcessToBeGone(parsePid(result.stdout, 'abort'));
  });

  it('returns spawn-failed for a missing binary without throwing', async () => {
    const result = await runner.run('/no/such/binary-ever', ['--version'], {
      onChunk: () => {},
    });

    expect(result.exitCode).toBe(-1);
    expect(result.failureKind).toBe('spawn-failed');
  });

  // bdboard-l1t.9 Opus レビュー M1: 直接の子が exit しても、孫プロセスが
  // stdout/stderr のパイプ fd を継承したまま生きていると Node の 'close' が
  // 永久に来ず run() が settle しない(=呼び出し元の busy lock がサーバー再起動
  // まで解放されない)。既存の timeout/abort テストは孫プロセスを作らないので
  // このバグを検知できなかった。ここでは孫プロセス(inherit stdio, detached)を
  // 明示的に作って再現する。
  it('settles quickly even when a grandchild process keeps the stdio pipes open after the child exits', async () => {
    // bdboard-l1t.9 delta 再レビュー nit: 孫プロセスは PID 捕捉に失敗しても
    // 永久リークしないよう、setInterval(無限ループ)ではなく自己終了する
    // setTimeout(8000ms 後に自然終了)にしておく。テスト内の SIGKILL 後始末が
    // 何らかの理由で走らなくても、この孫プロセスは自分で片付く。
    const grandchildScript =
      "const { spawn } = require('node:child_process');" +
      "const gc = spawn(process.execPath, ['-e', 'process.stdout.write(String(process.pid)); setTimeout(() => {}, 8000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });" +
      'gc.unref();' +
      'process.exit(0);';

    const chunks: string[] = [];
    const start = Date.now();
    const result = await runner.run(process.execPath, ['-e', grandchildScript], {
      // タイムアウトで settle してしまうと「バックストップが効いた」のか
      // 「待ちきれずに殺した」のかが区別できない。孫プロセスの寿命(8秒)より
      // 十分長く取り、バックストップだけが settle させ得る状態にする
      // (bdboard-dvt)。
      timeoutMs: 20_000,
      onChunk: (chunk) => chunks.push(chunk.text),
    });
    const elapsedMs = Date.now() - start;

    expect(result.exitCode).toBe(0);
    // バックストップは 'exit' から300ms後(delta 再レビュー nit で50ms→300msに
    // 変更)。実測の settle は 320〜330ms 前後。バックストップが壊れると孫が
    // 自然終了する 8 秒まで待つことになるので、その間のどこかに線を引けば
    // 十分に判別できる。負荷の高いマシンでの揺れを吸収するため 3 秒に取る
    // (bdboard-dvt: 1000ms は実測値に対して余裕が 3 倍しかなかった)。
    expect(elapsedMs).toBeLessThan(3_000);

    const grandchildPid = Number(chunks.join(''));
    if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
      try {
        process.kill(grandchildPid, 'SIGKILL');
      } catch {
        // すでに居なければ何もしない(ベストエフォートな後始末)。
      }
    }
    // vitest の既定タイムアウト(5秒)より長く待てるようにしておく
    // (bdboard-dvt)。バックストップが壊れると settle は孫の寿命(8秒)まで
    // 延びるが、そこで「テストがタイムアウトした」と言われるより、
    // 上の elapsedMs の assertion が「遅すぎる」と言って落ちるほうが原因に
    // 直結する。
  }, 15_000);

  it('kills grandchild processes in the same process group on timeout', async () => {
    const childScript =
      "const { spawn } = require('node:child_process');" +
      "const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10_000)']);" +
      "process.stdout.write(String(gc.pid) + ':' + String(process.pid));" +
      'setInterval(() => {}, 10_000);';

    const result = await runner.run(process.execPath, ['-e', childScript], {
      // 予算は子と孫の2プロセス分の起動を含む(bdboard-dvt)。
      timeoutMs: 1_000,
      onChunk: () => {},
    });

    expect(result.failureKind).toBe('timeout');
    const grandchildPid = parsePid(result.stdout.split(':')[0] ?? '', 'group kill / timeout');
    await expectProcessToBeGone(grandchildPid);
  });

  it('kills grandchild processes in the same process group on abort', async () => {
    const childScript =
      "const { spawn } = require('node:child_process');" +
      "const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10_000)']);" +
      "process.stdout.write(String(gc.pid) + ':' + String(process.pid));" +
      'setInterval(() => {}, 10_000);';

    const controller = new AbortController();
    // 固定待ちではなく、pid が届いたことを合図に abort する(bdboard-dvt)。
    const result = await runner.run(process.execPath, ['-e', childScript], {
      signal: controller.signal,
      onChunk: () => controller.abort(),
    });

    expect(result.failureKind).toBe('aborted');
    const grandchildPid = parsePid(result.stdout.split(':')[0] ?? '', 'group kill / abort');
    await expectProcessToBeGone(grandchildPid);
  });
  // bdboard-qrrj: SIGTERM を無視する子に対する forceStop 経路(SIGTERM →
  // STOP_GRACE_MS の猶予 → SIGKILL)は、これまで一度も実行されていなかった。
  // 既存テストの子はどれも SIGTERM で即死するので stop() の中で完結してしまい、
  // 猶予タイマーも SIGKILL も踏まないまま全件グリーンになる。
  //
  // 起点に timeout ではなく abort を使う。stop() 以降の経路は両者で完全に同じ
  // だが、timeoutMs は run() を呼んだ瞬間から測り始めるので、子が SIGTERM
  // ハンドラを張り終える前(= node の起動中)に SIGTERM が届く競合が残る。
  // そうなると子は既定動作で即死し、エスカレーションが起きないまま 500ms 前後で
  // settle して下限アサーションが落ちる。abort なら「子が pid を書いた」= ハンドラ
  // 設置後、という合図で撃てるので競合そのものが無くなる(PR#151 レビュー minor-1。
  // 予算を広げて誤魔化すのではなく競合を消す、という bdboard-dvt と同じ直し方)。
  //
  // Windows では成立しないので回す意味が無い。killProcessTree は win32 だと
  // SIGTERM 相当でも taskkill /F を撃つ(windowsHide のせいで WM_CLOSE が届かない
  // ため。kill-process-tree.ts のコメント参照)ので、子はそもそも SIGTERM を
  // 無視できず、SIGTERM → 猶予 → SIGKILL のエスカレーション自体が存在しない。
  it.skipIf(process.platform === 'win32')(
    'escalates to SIGKILL after the grace period when the child ignores SIGTERM',
    async () => {
      const childScript =
        "process.on('SIGTERM', () => {});" +
        "const { spawn } = require('node:child_process');" +
        // 孫その1: detached にして親のプロセスグループから外す。グループへの SIGTERM で
        // 巻き添えに死んでしまうと「パイプを握ったまま生き残る孫」を再現できない。
        // グループ kill が届かない位置に置く以上、取り残しを防ぐのは自己終了だけなので
        // setInterval ではなく setTimeout にする(bdboard-l1t.9 レビューと同じ理由)。
        "const outside = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], " +
        "{ stdio: ['ignore', 'inherit', 'inherit'], detached: true });" +
        'outside.unref();' +
        // 孫その2: グループ内に残し、こちらも SIGTERM を無視する。forceStop の
        // SIGKILL が「子だけ」ではなく「グループごと」に飛んでいることを固定する。
        // これが無いと killProcessTree(child,'SIGKILL') を child.kill('SIGKILL') に
        // 差し替える変異が生き残る(PR#151 レビュー minor-2)。
        "const inside = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); \" +" +
        "\"process.stdout.write('ready'); setTimeout(() => {}, 10000)\"], " +
        "{ stdio: ['ignore', 'pipe', 'ignore'] });" +
        // 孫その2 の準備完了(SIGTERM ハンドラ設置)を待ってから pid 行を出す。
        // これを待たずに出すと、abort → グループへの SIGTERM が孫のハンドラ設置より
        // 先に届き、孫が既定動作で死ぬ。すると「グループごと SIGKILL したから
        // 消えた」のか「SIGTERM で死んだ」のかが区別できず、minor-2 が狙った
        // 変異(SIGKILL をグループではなく子だけに撃つ)を取り逃がす。実際、
        // ハンドシェイク無しの版では取り逃がしていた。
        "inside.stdout.once('data', () => {" +
        "process.stdout.write([process.pid, outside.pid, inside.pid].join(':'));" +
        '});' +
        'setTimeout(() => {}, 10_000);';

      const controller = new AbortController();
      // 壁時計だと計測中の NTP ステップで偽陰性になり得るので単調時計を使う
      // (PR#151 レビュー nit-1)。
      let abortedAt = 0;
      const result = await runner.run(process.execPath, ['-e', childScript], {
        signal: controller.signal,
        onChunk: () => {
          if (abortedAt === 0) {
            abortedAt = performance.now();
            controller.abort();
          }
        },
      });
      const settleMs = performance.now() - abortedAt;

      expect(result.failureKind).toBe('aborted');
      // SIGKILL された子の exit code は null なので -1 に潰れる。
      expect(result.exitCode).toBe(-1);

      // 猶予を実際に待ったことの証明。SIGTERM で子が死んでいれば abort 直後に
      // settle するので、ここが「エスカレーションが起きた」の判定になる。
      // タイマーは指定より早くは発火しないので下限側は原理的に安定している。
      expect(settleMs).toBeGreaterThanOrEqual(2_900);
      // 上限は「猶予をもう一周していない」ことだけを見る緩い枠。実測は猶予明けから
      // 5〜6ms なので、負荷でイベントループが数秒詰まっても揺れない
      // (bdboard-dvt と同じ轍を踏まないための余裕)。
      expect(settleMs).toBeLessThan(7_000);

      const [childField, outsideField, insideField] = result.stdout.split(':');
      const childPid = parsePid(childField ?? '', 'SIGKILL escalation / child');
      const insidePid = parsePid(insideField ?? '', 'SIGKILL escalation / in-group grandchild');
      const outsidePid = Number(outsideField);

      try {
        await expectProcessToBeGone(childPid);
        // グループ内の孫も SIGTERM を無視しているので、消えていれば SIGKILL が
        // グループに飛んだ証拠になる。
        await expectProcessToBeGone(insidePid);
      } finally {
        // グループ外の孫は意図的に生き残っている。10 秒で自分から終わるが、
        // テストを跨いで居座らせる理由も無いのでベストエフォートで片付ける。
        // アサーションが落ちた場合でも走るよう finally に置く
        // (PR#151 レビュー nit-2)。
        if (Number.isInteger(outsidePid) && outsidePid > 0) {
          try {
            process.kill(outsidePid, 'SIGKILL');
          } catch {
            // すでに居なければ何もしない。
          }
        }
      }
    },
    15_000,
  );
});
