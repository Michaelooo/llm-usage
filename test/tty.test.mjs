import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ACTIVE_FRAME_INTERVAL_MS,
  createAdaptiveFrameLoop,
  createFrameWriter,
  DISABLE_WRAP,
  ENABLE_WRAP,
  HIDE_CURSOR,
  IDLE_FRAME_INTERVAL_MS,
  SHOW_CURSOR,
} from '../src/tty.mjs';

test('光标隐藏和恢复控制符保持可用', () => {
  assert.equal(HIDE_CURSOR, '\x1b[?25l');
  assert.equal(SHOW_CURSOR, '\x1b[?25h');
});

test('自动折行开关控制符保持可用', () => {
  assert.equal(DISABLE_WRAP, '\x1b[?7l');
  assert.equal(ENABLE_WRAP, '\x1b[?7h');
});

test('动态帧循环在请求中使用 140ms，空闲时使用 1s', () => {
  const delays = [];
  const callbacks = [];
  let active = true;
  let draws = 0;

  const loop = createAdaptiveFrameLoop({
    draw() { draws += 1; },
    isActive: () => active,
    schedule(callback, delay) {
      callbacks.push(callback);
      delays.push(delay);
      return { unref() {} };
    },
    cancelSchedule() {},
  });

  assert.equal(draws, 1, '启动时立即绘制首帧');
  assert.equal(delays[0], ACTIVE_FRAME_INTERVAL_MS);

  active = false;
  callbacks.shift()();
  assert.equal(draws, 2);
  assert.equal(delays[1], IDLE_FRAME_INTERVAL_MS);

  active = true;
  callbacks.shift()();
  assert.equal(delays[2], ACTIVE_FRAME_INTERVAL_MS);
  loop.stop();
});

test('动态帧循环停止后不再绘制，也会取消待执行 timer', () => {
  const callbacks = [];
  const cancelled = [];
  let draws = 0;
  let nextId = 0;
  const loop = createAdaptiveFrameLoop({
    draw() { draws += 1; },
    isActive: () => false,
    schedule(callback) {
      callbacks.push(callback);
      nextId += 1;
      return nextId;
    },
    cancelSchedule(id) { cancelled.push(id); },
  });

  loop.stop();
  assert.deepEqual(cancelled, [1]);
  callbacks[0]();
  assert.equal(draws, 1, '停止后残留回调不得再次绘制');
});

const ESC = '\x1b';
const ERASE_TO_EOL = `${ESC}[K`;

// node:readline 的 cursorTo/moveCursor 也会往 stream 写，
// 所以按「每次 write 调用产生的全部输出」来断言，而不是数写入次数
function fakeStream() {
  const chunks = [];
  return {
    chunks,
    isTTY: true,
    columns: 100,
    rows: 40,
    write(chunk) { chunks.push(chunk); return true; },
  };
}

function emit(stream, writer, lines) {
  const before = stream.chunks.length;
  writer.write(lines);
  return stream.chunks.slice(before).join('');
}

test('内容不变时完全不写，避免按帧率无谓刷屏', () => {
  const stream = fakeStream();
  const writer = createFrameWriter(stream);

  assert.notEqual(emit(stream, writer, ['a', 'b']), '', '首帧应写出');
  assert.equal(emit(stream, writer, ['a', 'b']), '', '相同帧不应产生任何输出');
  assert.equal(emit(stream, writer, ['a', 'b']), '', '连续相同帧同样静默');
  assert.notEqual(emit(stream, writer, ['a', 'c']), '', '内容变化才写');
});

test('行数不变时只重绘变化的行', () => {
  const stream = fakeStream();
  const writer = createFrameWriter(stream);

  emit(stream, writer, ['line-1', 'line-2', 'line-3']);
  const output = emit(stream, writer, ['line-1', 'line-2-changed', 'line-3']);

  assert.ok(output.includes('line-2-changed'), '变化的行应被写出');
  assert.ok(output.includes(ERASE_TO_EOL), '重绘的行要擦到行尾');
  assert.equal(output.includes('line-1'), false, '未变化的行不应重写');
  assert.equal(output.includes('line-3'), false, '未变化的行不应重写');
});

test('整帧重排在一次写入内完成，不存在只清不写的空白窗口', () => {
  const stream = fakeStream();
  const writer = createFrameWriter(stream);

  emit(stream, writer, ['a', 'b']);
  // 行数变化触发整块重排
  const before = stream.chunks.length;
  writer.write(['x', 'y', 'z']);
  const chunks = stream.chunks.slice(before);

  assert.equal(chunks.length, 1, '整帧必须一次写出，避免中间态被终端刷到');
  for (const line of ['x', 'y', 'z']) {
    assert.ok(chunks[0].includes(line), `重排应包含 ${line}`);
  }
});

test('多行同时变化时按顺序定位，最后回到块尾', () => {
  const stream = fakeStream();
  const writer = createFrameWriter(stream);

  emit(stream, writer, ['a', 'b', 'c', 'd']);
  const output = emit(stream, writer, ['a', 'B', 'c', 'D']);

  assert.ok(output.includes('B') && output.includes('D'), '两处变化都要重绘');
  assert.equal(output.includes('a'), false, '未变化的行不重写');
  // 从块尾(3) 上移到 1，再下移到 3
  assert.ok(output.includes(`${ESC}[2A`), '应先上移到第一处变化');
  assert.ok(output.includes(`${ESC}[2B`), '应下移到第二处变化');
});

test('新帧变短时清掉多余的行并把光标移回块尾', () => {
  const stream = fakeStream();
  const writer = createFrameWriter(stream);

  emit(stream, writer, ['1', '2', '3', '4']);
  const output = emit(stream, writer, ['1', '2']);

  assert.ok(output.includes(`${ESC}[2A`), `应把光标上移 2 行回到块尾，实际: ${JSON.stringify(output)}`);
});

test('新帧变长时不需要额外的光标回退', () => {
  const stream = fakeStream();
  const writer = createFrameWriter(stream);

  emit(stream, writer, ['1']);
  const output = emit(stream, writer, ['1', '2', '3']);

  assert.equal(output.includes(`${ESC}[1A`), false, '变长时不应有回退');
  assert.equal(output.includes(`${ESC}[2A`), false, '变长时不应有回退');
});

test('clear 之后重新写入按首帧处理', () => {
  const stream = fakeStream();
  const writer = createFrameWriter(stream);

  emit(stream, writer, ['a', 'b']);
  writer.clear();
  assert.notEqual(emit(stream, writer, ['a', 'b']), '', 'clear 后应重新写出，不被去重吃掉');
});

// 字宽误算（终端把 ● ─ █ ░ 等歧义字符按双宽渲染）会让帧行实际超宽而自动折行，
// 一行文本占两行终端行，光标模型随每次重绘逐轮下移，看板会重复出一整列旧帧
test('首帧先关掉自动折行，超宽行被裁剪而不是折行', () => {
  const stream = fakeStream();
  const writer = createFrameWriter(stream);

  const first = emit(stream, writer, ['a', 'b']);
  assert.ok(first.startsWith(DISABLE_WRAP), `关折行要早于任何内容，实际: ${JSON.stringify(first)}`);

  const second = emit(stream, writer, ['a', 'c']);
  assert.equal(second.includes(DISABLE_WRAP), false, '已关闭就不必每帧重复下发');
});

test('clear 把自动折行交还终端，再次接管时重新关闭', () => {
  const stream = fakeStream();
  const writer = createFrameWriter(stream);
  emit(stream, writer, ['a', 'b']);

  const before = stream.chunks.length;
  writer.clear();
  const cleared = stream.chunks.slice(before).join('');
  assert.ok(cleared.includes(ENABLE_WRAP), 'clear 后终端必须恢复自动折行，不能把 watch 的模式留给 shell');

  assert.ok(emit(stream, writer, ['a', 'b']).includes(DISABLE_WRAP), '重新接管要再次关掉折行');
});
