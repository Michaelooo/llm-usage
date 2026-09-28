import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canRunInteractiveSetup } from '../src/runtime.mjs';
import { mergeProviderConfig, retainUnmanagedProviders } from '../src/setup.mjs';

const CLI_PATH = new URL('../bin/llm-usage.mjs', import.meta.url).pathname;
const MOCK_CLI_PATH = new URL('../test-support/run-cli-with-mocks.mjs', import.meta.url).pathname;

test('JSON 模式独立禁止交互配置', () => {
  assert.equal(canRunInteractiveSetup({ json: true }, { env: {}, stdinIsTTY: true, stdoutIsTTY: true }), false);
});

test('CI 模式独立禁止交互配置', () => {
  assert.equal(canRunInteractiveSetup({ json: false }, { env: { CI: 'true' }, stdinIsTTY: true, stdoutIsTTY: true }), false);
});

test('输入或输出为管道时独立禁止交互配置', () => {
  assert.equal(canRunInteractiveSetup({ json: false }, { env: {}, stdinIsTTY: false, stdoutIsTTY: true }), false);
  assert.equal(canRunInteractiveSetup({ json: false }, { env: {}, stdinIsTTY: true, stdoutIsTTY: false }), false);
});

test('setup 写回时保留 Codex 和 Claude 已有 access token', () => {
  assert.deepEqual(
    mergeProviderConfig({ access_token: 'codex-secret', auth_path: '/tmp/auth.json' }, true),
    { enabled: true, access_token: 'codex-secret', auth_path: '/tmp/auth.json' },
  );
  assert.deepEqual(mergeProviderConfig({ access_token: 'claude-secret' }, true), {
    enabled: true,
    access_token: 'claude-secret',
  });
});

test('env-only 的 JSON、CI 和管道模式无需交互配置文件', () => {
  const testHome = mkdtempSync(join(tmpdir(), 'llm-usage-cli-'));
  try {
    const result = spawnSync(process.execPath, [MOCK_CLI_PATH, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: testHome, CI: 'true', LLM_USAGE_KIMI_API_KEY: 'kimi-env-secret' },
      timeout: 10_000,
    });
    assert.equal(result.signal, null);
    assert.equal(result.stderr.includes('选择要启用的 provider'), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes('kimi-env-secret'), false);
    assert.equal(existsSync(join(testHome, '.config/llm-usage/config.yaml')), false);
    assert.equal(JSON.parse(result.stdout)['Kimi Coding'].lines[0].percent, 10);
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
});

test('两个 Kimi 账号各自查询各自的额度，输出按 label 区分', () => {
  const testHome = mkdtempSync(join(tmpdir(), 'llm-usage-multi-'));
  try {
    const configDir = join(testHome, '.config/llm-usage');
    const configPath = join(configDir, 'config.yaml');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, [
      'providers:',
      '  kimi:',
      '    enabled: true',
      '    label: "Kimi 工作号"',
      '    api_key: "kimi-key-a"',
      '  kimi-2:',
      '    enabled: true',
      '    type: "kimi"',
      '    label: "Kimi 个人号"',
      '    api_key: "kimi-key-b"',
      '',
    ].join('\n'));
    const result = spawnSync(process.execPath, [MOCK_CLI_PATH, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: testHome, CI: 'true' },
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output['Kimi 工作号'].lines[0].remaining, 90);
    assert.equal(output['Kimi 个人号'].lines[0].remaining, 120);
    assert.equal(`${result.stdout}${result.stderr}`.includes('kimi-key-'), false);
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
});

test('没有任何启用的 provider 时给出配置指引并以 1 退出', () => {
  const testHome = mkdtempSync(join(tmpdir(), 'llm-usage-empty-'));
  try {
    const result = spawnSync(process.execPath, [MOCK_CLI_PATH, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: testHome, CI: 'true' },
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--setup/);
    assert.doesNotMatch(result.stderr, /at .*\.mjs:\d+/);
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
});

test('--setup 整份重写配置时不会丢掉手写的额外账号实例', () => {
  const existing = {
    kimi: { enabled: true, api_key: 'key-a' },
    'kimi-2': { enabled: true, type: 'kimi', label: 'Kimi B', api_key: 'key-b' },
  };
  const providers = retainUnmanagedProviders({ kimi: mergeProviderConfig(existing.kimi, true) }, existing);
  assert.deepEqual(providers['kimi-2'], existing['kimi-2']);
  assert.equal(providers.kimi.enabled, true);
  assert.equal(providers.kimi.api_key, 'key-a');
});

test('CLI 帮助不再暴露已删除的专用命令', () => {
  const result = spawnSync(process.execPath, [CLI_PATH, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /reset|快捷链接/);
});
