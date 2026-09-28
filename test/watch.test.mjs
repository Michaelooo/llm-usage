import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  createWatcher,
  createInitialState,
  applyQuotaResult,
  applyQuotaError,
  applyTokenResult,
  applyTokenError,
  isStale,
  MAX_EVENTS,
} from '../src/watch.mjs';
import { renderDashboard } from '../src/renderer.mjs';
import { stripAnsi } from '../src/utils.mjs';

const START = 1_700_000_000_000;

function quotaResult(remaining, { meta = '' } = {}) {
  return {
    meta,
    remainingUsd: remaining,
    lines: [{
      label: '额度',
      used: 500 - remaining,
      limit: 500,
      unit: 'USD',
      percent: ((500 - remaining) / 500) * 100,
      remaining,
    }],
  };
}

function fakeProvider(overrides = {}) {
  return {
    name: 'Kimi',
    color: '',
    async fetch() { return quotaResult(400); },
    ...overrides,
  };
}

function makeEntries(provider, config = {}) {
  return [{ name: 'kimi', provider, config }];
}

function plainLines(state, now = START) {
  return renderDashboard(state, { columns: 120, now }).map(stripAnsi);
}

test('拉取失败时保留上一轮成功值并标记为 stale', () => {
  const state = createInitialState(makeEntries(fakeProvider()), START);
  applyQuotaResult(state, 'kimi', quotaResult(400), START);
  applyQuotaError(state, 'kimi', new Error('网络抖动'), START + 60_000);

  const entry = state.providers[0];
  assert.equal(isStale(entry), true);
  assert.equal(entry.result.remainingUsd, 400);

  const rendered = plainLines(state, START + 60_000).join('\n');
  assert.match(rendered, /\$400\.00/);
  assert.match(rendered, /1m 前的数据/);
  assert.match(plainLines(state, START + 19_000).join('\n'), /19s 前的数据/);
});

test('成功刷新后 prev 保存上一轮值并渲染变化量', () => {
  const state = createInitialState(makeEntries(fakeProvider()), START);
  applyQuotaResult(state, 'kimi', quotaResult(400), START);
  applyQuotaResult(state, 'kimi', quotaResult(396.8), START + 60_000);
  assert.match(plainLines(state, START + 60_000).join('\n'), /↓\$3\.20/);
});

test('首轮没有基准时不显示变化量', () => {
  const state = createInitialState(makeEntries(fakeProvider()), START);
  applyQuotaResult(state, 'kimi', quotaResult(400), START);
  assert.equal(/[↓↑]/.test(plainLines(state).join('\n')), false);
});

test('数值未变化时显示持平而不是伪造变化量', () => {
  const state = createInitialState(makeEntries(fakeProvider()), START);
  applyQuotaResult(state, 'kimi', quotaResult(400), START);
  applyQuotaResult(state, 'kimi', quotaResult(400), START + 60_000);
  const rendered = plainLines(state, START + 60_000).join('\n');
  assert.equal(/[↓↑]/.test(rendered), false);
  assert.match(rendered, /—/);
});

test('事件列表只保留最近若干条', () => {
  const state = createInitialState(makeEntries(fakeProvider()), START);
  for (let i = 0; i < MAX_EVENTS + 3; i++) {
    state.events.push({ at: START, text: `事件 ${i}`, kind: 'info' });
    if (state.events.length > MAX_EVENTS) state.events.shift();
  }
  assert.equal(state.events.length, MAX_EVENTS);
});

test('刷新中显示动画指示器，空闲显示下次刷新倒计时', () => {
  const state = createInitialState(makeEntries(fakeProvider()), START);
  state.quota.pending = true;
  assert.match(plainLines(state)[0], /刷新中/);

  state.quota.pending = false;
  state.quota.nextAt = START + 45_000;
  assert.match(plainLines(state)[0], /下次 00:45/);
});

const TOKEN_REPORT = {
  entries: [
    {
      client: 'claude', provider: 'anthropic', model: 'claude-opus-5', messageCount: 143,
      input: 62_772, output: 137_493, cacheRead: 16_969_709, cacheWrite: 690_075, cost: 16.55,
    },
    {
      client: 'codex', provider: 'kimi', model: 'gpt-5.6-sol', messageCount: 89,
      input: 766_188, output: 39_048, cacheRead: 9_876_736, cacheWrite: 0, cost: 10.3,
    },
  ],
  totalInput: 828_960,
  totalOutput: 176_541,
  totalCacheRead: 26_846_445,
  totalCacheWrite: 690_075,
  totalMessages: 232,
  totalCost: 26.85,
};

test('Token 区有独立时间戳，与额度刷新解耦', () => {
  const state = createInitialState(makeEntries(fakeProvider()), START);
  applyTokenResult(state, TOKEN_REPORT, START);
  state.token.nextAt = START + 600_000;

  const rendered = plainLines(state, START + 300_000).join('\n');
  assert.match(rendered, /今日消耗/);
  assert.match(rendered, /更新于/);
  assert.match(rendered, /下次 05:00/);
  assert.match(plainLines(state)[0], /下次 00:00/);
});

test('watch 展示完整 Token 明细表', () => {
  const state = createInitialState(makeEntries(fakeProvider()), START);
  applyTokenResult(state, TOKEN_REPORT, START);
  const rendered = renderDashboard(state, { columns: 160, rows: 60, now: START }).map(stripAnsi).join('\n');
  assert.match(rendered, /客户端/);
  assert.match(rendered, /缓存读取/);
  assert.match(rendered, /claude-opus-5/);
  assert.match(rendered, /gpt-5\.6-sol/);
  assert.match(rendered, /个客户端 \/ 2 条记录/);
  assert.match(rendered, /合计/);
});

test('终端高度不足时退回一行汇总，避免帧超屏', () => {
  const state = createInitialState(makeEntries(fakeProvider()), START);
  applyQuotaResult(state, 'kimi', quotaResult(400), START);
  applyTokenResult(state, TOKEN_REPORT, START);

  const tall = renderDashboard(state, { columns: 160, rows: 60, now: START });
  assert.match(tall.map(stripAnsi).join('\n'), /claude-opus-5/);

  const short = renderDashboard(state, { columns: 160, rows: 9, now: START });
  assert.ok(short.length <= 8);
  assert.ok(short.length < tall.length);
  const shortText = short.map(stripAnsi).join('\n');
  assert.match(shortText, /条消息/);
  assert.equal(/claude-opus-5/.test(shortText), false);

  const tiny = renderDashboard(state, { columns: 160, rows: 4, now: START });
  assert.ok(tiny.length <= 3);
});

test('移除快捷链接后看板只保留额度、Token 和事件区', () => {
  const state = createInitialState(makeEntries(fakeProvider()), START);
  applyQuotaResult(state, 'kimi', quotaResult(400), START);
  applyTokenResult(state, TOKEN_REPORT, START);
  const rendered = renderDashboard(state, { columns: 160, rows: 60, now: START }).map(stripAnsi).join('\n');
  assert.match(rendered, /LLM 使用总览/);
  assert.match(rendered, /今日消耗/);
  assert.equal(rendered.includes('快捷链接'), false);
  assert.equal(rendered.includes('\x1b]8;;'), false);
});

test('看板不展示轮次和运行时长', () => {
  const state = createInitialState(makeEntries(fakeProvider()), START);
  state.round = 42;
  applyQuotaResult(state, 'kimi', quotaResult(400), START);
  const rendered = plainLines(state, START + 3_600_000).join('\n');
  assert.equal(/第 \d+ 轮/.test(rendered), false);
  assert.equal(/运行 \d+:\d+/.test(rendered), false);
});

test('窄终端下每行都裁剪到宽度内', () => {
  const state = createInitialState(makeEntries(fakeProvider()), START);
  applyQuotaResult(state, 'kimi', quotaResult(400, { meta: '11 models · 总额度 $9,179.35' }), START);
  const lines = renderDashboard(state, { columns: 40, now: START });
  for (const line of lines) assert.ok(stripAnsi(line).length <= 40, `行超宽: ${stripAnsi(line)}`);
});

test('看板裁剪后仍保留 ANSI 颜色', () => {
  const state = createInitialState([
    { name: 'kimi', provider: fakeProvider({ color: '\x1b[36m' }), config: {} },
  ], START);
  applyQuotaResult(state, 'kimi', quotaResult(400, { meta: 'x'.repeat(200) }), START);
  assert.ok(renderDashboard(state, { columns: 50, now: START }).join('\n').includes('\x1b['));
});

test('错误信息里的换行被压平，帧行与终端行一一对应', () => {
  const state = createInitialState(makeEntries(fakeProvider()), START);
  applyQuotaError(state, 'kimi', new Error('HTTP 401: {"error":"sso"}\r\n'), START);
  applyTokenError(state, new Error('tokscale 查询失败: 第一行\n第二行'), START);

  const lines = renderDashboard(state, { columns: 120, now: START });
  for (const line of lines) assert.equal(/[\t\n\v\f\r]/.test(line), false);
  const rendered = lines.map(stripAnsi).join('\n');
  assert.match(rendered, /HTTP 401: \{"error":"sso"\}/);
  assert.match(rendered, /tokscale 查询失败: 第一行 第二行/);
});

test('上一轮未完成时跳过本轮，不并发堆积请求', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const provider = fakeProvider({
    async fetch() {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return quotaResult(400);
    },
  });
  const watcher = createWatcher({
    entries: makeEntries(provider), quotaIntervalSec: 60, tokenIntervalSec: 600,
    fetchTokenUsage: async () => ({}),
  });

  const first = watcher.refreshQuota();
  await watcher.refreshQuota();
  await watcher.refreshQuota();
  release();
  await first;

  assert.equal(maxInFlight, 1);
  assert.equal(watcher.state.round, 1);
});

test('单个 provider 失败不影响其他 provider 的结果', async () => {
  const ok = { name: 'Kimi', color: '', async fetch() { return quotaResult(400); } };
  const bad = { name: 'GLM', color: '', async fetch() { throw new Error('boom'); } };
  const watcher = createWatcher({
    entries: [{ name: 'kimi', provider: ok, config: {} }, { name: 'glm', provider: bad, config: {} }],
    quotaIntervalSec: 60, tokenIntervalSec: 600, fetchTokenUsage: async () => ({}),
  });

  await watcher.refreshQuota();
  assert.equal(watcher.state.providers[0].result.remainingUsd, 400);
  assert.match(watcher.state.providers[1].error.message, /boom/);
  assert.equal(watcher.state.quota.pending, false);
});

test('错误信息经过脱敏，不泄露 API Key', async () => {
  const provider = fakeProvider({ async fetch() { throw new Error('failed for apiKey sk-supersecretvalue123'); } });
  const watcher = createWatcher({
    entries: makeEntries(provider), secrets: ['sk-supersecretvalue123'],
    quotaIntervalSec: 60, tokenIntervalSec: 600, fetchTokenUsage: async () => ({}),
  });
  await watcher.refreshQuota();
  assert.equal(watcher.state.providers[0].error.message.includes('sk-supersecretvalue123'), false);
});

test('Token 刷新失败保留上一次成功报告', async () => {
  let call = 0;
  const watcher = createWatcher({
    entries: makeEntries(fakeProvider()), quotaIntervalSec: 60, tokenIntervalSec: 600,
    fetchTokenUsage: async () => {
      call += 1;
      if (call === 1) return { totalMessages: 7, totalCost: 2 };
      throw new Error('tokscale 挂了');
    },
  });
  await watcher.refreshToken();
  await watcher.refreshToken();
  assert.equal(watcher.state.token.report.totalMessages, 7);
  assert.match(watcher.state.token.error.message, /tokscale/);
});

test('同一实现的多个账号在看板上按各自 label 区分', () => {
  const entries = [
    { name: 'kimi', type: 'kimi', provider: fakeProvider(), label: 'Kimi (我)' },
    { name: 'kimi-2', type: 'kimi', provider: fakeProvider(), label: 'Kimi (个人)' },
  ];
  const state = createInitialState(entries, START);
  applyQuotaResult(state, 'kimi', quotaResult(400), START);
  applyQuotaResult(state, 'kimi-2', quotaResult(200), START);
  const rendered = plainLines(state).join('\n');
  assert.match(rendered, /● Kimi \(我\)/);
  assert.match(rendered, /● Kimi \(个人\)/);
});

test('同一实现的多个账号，标题的 meta 对齐到同一列', () => {
  const entries = [
    { name: 'kimi', type: 'kimi', provider: fakeProvider(), label: 'Kimi (chengpengfei)' },
    { name: 'kimi-2', type: 'kimi', provider: fakeProvider(), label: 'Kimi (chenglin)' },
    { name: 'glm', type: 'glm', provider: fakeProvider({ name: 'GLM' }) },
  ];
  const state = createInitialState(entries, START);
  applyQuotaResult(state, 'kimi', { meta: '13 models', lines: [{ label: '额度', used: 200, limit: 500, unit: 'USD', percent: 40, remaining: 300 }] }, START);
  applyQuotaResult(state, 'kimi-2', { meta: '13 models', lines: [{ label: '额度', used: 242, limit: 500, unit: 'USD', percent: 48.4, remaining: 258 }] }, START);
  applyQuotaResult(state, 'glm', { meta: '8,349 / 1,000,000 Credit', lines: [{ label: '额度', used: 8349, limit: 1000000, unit: 'Credit', percent: 1, remaining: 991651 }] }, START);
  const lines = plainLines(state);
  const titles = lines.filter(line => line.startsWith('● Kimi'));
  assert.equal(titles.length, 2);
  assert.equal(titles[0].indexOf('· 13 models'), titles[1].indexOf('· 13 models'));
  assert.equal(lines.find(line => line.startsWith('● GLM')), '● GLM  · 8,349 / 1,000,000 Credit');
});

test('标题没有后缀时不产生尾随空格', () => {
  const state = createInitialState([
    { name: 'kimi', type: 'kimi', provider: fakeProvider(), label: 'Kimi (chengpengfei)' },
    { name: 'kimi-2', type: 'kimi', provider: fakeProvider(), label: 'Kimi (chenglin)' },
  ], START);
  applyQuotaResult(state, 'kimi', { meta: '', lines: [] }, START);
  applyQuotaResult(state, 'kimi-2', { meta: '', lines: [] }, START);
  for (const line of plainLines(state)) assert.equal(line, line.replace(/\s+$/, ''));
});

test('热重载保留存活 provider 已取到的数字和增量基准', async () => {
  const watcher = createWatcher({
    entries: [
      { name: 'kimi', type: 'kimi', provider: fakeProvider(), label: 'A', config: {} },
      { name: 'glm', type: 'glm', provider: fakeProvider({ name: 'GLM' }), label: 'GLM', config: {} },
    ],
    quotaIntervalSec: 60, tokenIntervalSec: 900, fetchTokenUsage: async () => ({}), now: () => START,
  });
  await watcher.refreshQuota();
  applyQuotaResult(watcher.state, 'kimi', quotaResult(300), START + 60_000);
  const before = watcher.state.providers.find(entry => entry.name === 'kimi');
  assert.equal(before.result.remainingUsd, 300);
  assert.equal(before.prev.remainingUsd, 400);

  watcher.updateEntries([
    { name: 'kimi', type: 'kimi', provider: fakeProvider(), label: 'A 改名了', config: {} },
    { name: 'kimi-2', type: 'kimi', provider: fakeProvider(), label: 'B', config: {} },
  ]);
  assert.deepEqual(watcher.state.providers.map(entry => entry.name), ['kimi', 'kimi-2']);
  const after = watcher.state.providers.find(entry => entry.name === 'kimi');
  assert.equal(after.result.remainingUsd, 300);
  assert.equal(after.prev.remainingUsd, 400);
  assert.equal(after.label, 'A 改名了');
  assert.equal(watcher.state.providers.find(entry => entry.name === 'kimi-2').result, null);
});

test('热重载后按新的 provider 列表拉取', async () => {
  const calls = [];
  const tracking = name => fakeProvider({ async fetch() { calls.push(name); return quotaResult(400); } });
  const watcher = createWatcher({
    entries: [{ name: 'kimi', provider: tracking('kimi'), config: {} }],
    quotaIntervalSec: 60, tokenIntervalSec: 900, fetchTokenUsage: async () => ({}),
  });
  await watcher.refreshQuota();
  watcher.updateEntries([{ name: 'glm', provider: tracking('glm'), config: {} }]);
  await watcher.refreshQuota();
  assert.deepEqual(calls, ['kimi', 'glm']);
});

test('热重载换掉脱敏名单，新密钥同样被遮住', async () => {
  const failing = fakeProvider({ async fetch() { throw new Error('鉴权失败: new-secret-key'); } });
  const watcher = createWatcher({
    entries: makeEntries(fakeProvider()), secrets: ['old-secret-key'], quotaIntervalSec: 60,
    tokenIntervalSec: 900, fetchTokenUsage: async () => ({}),
  });
  watcher.updateEntries([{ name: 'kimi', provider: failing, config: {} }], ['new-secret-key']);
  await watcher.refreshQuota();
  const entry = watcher.state.providers.find(item => item.name === 'kimi');
  assert.equal(entry.error.message.includes('new-secret-key'), false);
  assert.match(entry.error.message, /\*\*\*/);
});

test('飞行中的请求回来时对应 provider 已被移除，不会报错也不写入', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const slow = fakeProvider({ async fetch() { await pending; return quotaResult(50); } });
  const watcher = createWatcher({
    entries: [{ name: 'kimi', provider: slow, config: {} }],
    quotaIntervalSec: 60, tokenIntervalSec: 900, fetchTokenUsage: async () => ({}),
  });
  const inFlight = watcher.refreshQuota();
  watcher.updateEntries([{ name: 'glm', provider: fakeProvider({ name: 'GLM' }), config: {} }]);
  release();
  await inFlight;
  assert.deepEqual(watcher.state.providers.map(entry => entry.name), ['glm']);
  assert.equal(watcher.state.events.some(event => event.kind === 'error'), false);
});
