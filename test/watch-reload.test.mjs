import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toYaml } from '../src/config.mjs';
import { stripAnsi } from '../src/utils.mjs';

const RUNNER = new URL('../test-support/run-watch-with-mocks.mjs', import.meta.url).pathname;
const WAIT_TIMEOUT_MS = 15_000;

function configYaml(providers) {
  return `${toYaml({ providers, watch: { quota_interval_sec: 600, token_interval_sec: 900 } })}\n`;
}

const ACCOUNT_A = { enabled: true, api_key: 'kimi-key-a' };
const ACCOUNT_B = { enabled: true, type: 'kimi', label: 'Kimi 个人号', api_key: 'kimi-key-b' };

function waitFor(predicate, describe) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`等待超时：${describe}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

test('watch 运行期间改动配置文件会就地重载，不需要重启', async t => {
  const home = mkdtempSync(join(tmpdir(), 'llm-usage-reload-'));
  const configPath = join(home, '.config/llm-usage/config.yaml');
  mkdirSync(join(home, '.config/llm-usage'), { recursive: true });
  writeFileSync(configPath, configYaml({ kimi: ACCOUNT_A }));

  const child = spawn(process.execPath, [RUNNER, '--watch'], {
    env: { ...process.env, HOME: home, CI: '' },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const screen = () => stripAnsi(output);
  t.after(() => { child.kill('SIGKILL'); });

  await waitFor(() => screen().includes('Kimi'), '首屏渲染出 Kimi');
  assert.equal(screen().includes('Kimi 个人号'), false);

  writeFileSync(configPath, configYaml({ kimi: ACCOUNT_A, 'kimi-2': ACCOUNT_B }));
  await waitFor(() => screen().includes('配置已重载'), '事件区出现「配置已重载」');
  await waitFor(() => screen().includes('Kimi 个人号'), '新账号出现在看板上');
  await waitFor(() => /Kimi 个人号[\s\S]*?120/.test(screen()), '新账号显示自己的额度');
});

test('配置文件写坏时保留旧配置继续运行，并在事件区报错', async t => {
  const home = mkdtempSync(join(tmpdir(), 'llm-usage-reload-'));
  const configPath = join(home, '.config/llm-usage/config.yaml');
  mkdirSync(join(home, '.config/llm-usage'), { recursive: true });
  writeFileSync(configPath, configYaml({ kimi: ACCOUNT_A }));

  const child = spawn(process.execPath, [RUNNER, '--watch'], {
    env: { ...process.env, HOME: home, CI: '' },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const screen = () => stripAnsi(output);
  t.after(() => { child.kill('SIGKILL'); });

  await waitFor(() => screen().includes('Kimi'), '首屏渲染出 Kimi');
  writeFileSync(configPath, configYaml({ kimi: ACCOUNT_A, 'kimi-2': { enabled: true, type: 'unknown' } }));
  await waitFor(() => screen().includes('配置已重载'), '未知实例被跳过且配置重载成功');
  assert.equal(child.exitCode, null);
  assert.ok(screen().includes('Kimi'));
});
