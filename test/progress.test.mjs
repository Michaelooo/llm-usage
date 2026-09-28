import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createLoadingIndicator, renderRaceFrame } from '../src/progress.mjs';
import { visualWidth } from '../src/utils.mjs';

function createTasks(entries) {
  return new Map(entries.map(([id, label, emoji, status = 'pending', stepMs = 200]) => [
    id,
    { id, label, emoji, status, stepMs },
  ]));
}

function createFakeStream({ isTTY = true, columns = 80 } = {}) {
  return {
    isTTY,
    columns,
    output: '',
    write(value) {
      this.output += value;
      return true;
    },
  };
}

test('赛马帧展示不同角色并在完成后跨线', () => {
  const tasks = createTasks([
    ['glm', 'GLM', '🐼', 'pending', 100],
    ['kimi', 'Kimi', '🐰', 'fulfilled', 100],
    ['tokens', 'Tokens', '🤖', 'rejected', 100],
  ]);
  const lines = renderRaceFrame(tasks, { columns: 80, startedAt: 0, now: 500 });
  const output = lines.join('\n');

  assert.match(output, /GLM.*🐼.*🏁.*奔跑中/);
  assert.match(output, /Kimi.*🏁 🐰.*✓ 完成/);
  assert.match(output, /Tokens.*🏁 🤖.*✗ 失败/);
  assert.equal(output.includes('%'), false);
  assert.equal(output.includes('ETA'), false);
});

test('等待角色匀速前进并停在终点前', () => {
  const tasks = createTasks([['kimi', 'Kimi', '🐰', 'pending', 100]]);
  const early = renderRaceFrame(tasks, { columns: 60, startedAt: 0, now: 100 })[0];
  const late = renderRaceFrame(tasks, { columns: 60, startedAt: 0, now: 100_000 })[0];

  assert.ok(early.indexOf('🐰') < late.indexOf('🐰'));
  assert.ok(late.indexOf('🐰') < late.indexOf('🏁'));
});

test('窄终端降级且每行不超过终端宽度', () => {
  const tasks = createTasks([
    ['glm', 'GLM', '🐼'],
    ['tokens', 'Tokens', '🤖'],
  ]);

  for (const columns of [80, 30, 15]) {
    const lines = renderRaceFrame(tasks, { columns, startedAt: 0, now: 500 });
    assert.ok(lines.every(line => visualWidth(line) <= Math.max(1, columns - 1)));
  }
});

test('非 TTY、CI、TERM=dumb 和 disabled 不写动画', () => {
  for (const options of [
    { stream: createFakeStream({ isTTY: false }), env: {} },
    { stream: createFakeStream(), env: { CI: 'true' } },
    { stream: createFakeStream(), env: { TERM: 'dumb' } },
    { stream: createFakeStream(), env: {}, disabled: true },
  ]) {
    const indicator = createLoadingIndicator({ tasks: ['kimi'], ...options });
    indicator.complete('kimi');
    indicator.stop();
    assert.equal(options.stream.output, '');
  }
});

test('完成、失败和 stop 幂等，失败摘要准确', () => {
  const stream = createFakeStream();
  let renderTick;
  let timerCleared = 0;
  const indicator = createLoadingIndicator({
    tasks: ['kimi', 'glm', 'tokens'],
    stream,
    env: {},
    now: (() => {
      let value = 0;
      return () => value += 100;
    })(),
    schedule(callback) {
      renderTick = callback;
      return { unref() {} };
    },
    cancelSchedule() {
      timerCleared++;
    },
  });

  indicator.complete('kimi');
  indicator.complete('kimi');
  indicator.fail('glm');
  indicator.complete('tokens');
  renderTick();
  indicator.stop();
  const outputAfterStop = stream.output;
  indicator.stop();

  assert.equal(timerCleared, 1);
  assert.equal(stream.output, outputAfterStop);
  assert.match(stream.output, /1 项失败/);
});
