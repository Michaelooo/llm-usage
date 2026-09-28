import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  stripAnsi,
  fmtUsd,
  formatCountdown,
  visualTruncate,
  visualTruncateAnsi,
  visualWidth,
  OSC8_CLOSE,
} from '../src/utils.mjs';

test('stripAnsi 剥离 ANSI 颜色码', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
});

test('fmtUsd 格式化为两位小数美元', () => {
  assert.equal(fmtUsd(1234.5), '$1,234.50');
});

test('visualWidth 正确计算 Emoji 和组合字符', () => {
  assert.equal(visualWidth('🐯'), 2);
  assert.equal(visualWidth('中文🐰'), 6);
  assert.equal(visualWidth('é'), 1);
  assert.equal(visualWidth('👨‍👩‍👧‍👦'), 2);
  assert.equal(visualTruncate('A🐯B', 3), 'A🐯');
});

test('formatCountdown 秒数倒计时', () => {
  assert.equal(formatCountdown(90000), '1d 1h');
  assert.equal(formatCountdown(0), '');
});

test('OSC 8 超链接不计入可见宽度', () => {
  const link = `\x1b]8;;https://example.com/a/very/long/url\x07点我${OSC8_CLOSE}`;
  assert.equal(stripAnsi(link), '点我');
  assert.equal(visualWidth(link), 4);
});

test('截断落在链接文本中间时补回 OSC 8 闭合序列', () => {
  const link = `\x1b]8;;https://example.com/\x07点我${OSC8_CLOSE}`;
  const cut = visualTruncateAnsi(link, 2);
  assert.equal(stripAnsi(cut), '点');
  assert.ok(cut.endsWith(OSC8_CLOSE));
  assert.equal(visualTruncateAnsi(link, 4), link);
});
