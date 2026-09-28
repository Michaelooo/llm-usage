import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import claude from '../src/providers/claude.mjs';
import codex, { formatWindowLabel } from '../src/providers/codex.mjs';
import glm from '../src/providers/glm.mjs';
import kimi from '../src/providers/kimi.mjs';
import { fetchJson } from '../src/utils.mjs';
import { createTokscaleEnv } from '../src/tokscale.mjs';
import { getEnabledProviders } from '../src/providers/index.mjs';

test('需要 API Key 的 Provider 会指出缺失的环境变量', async () => {
  await assert.rejects(kimi.fetch({}), /LLM_USAGE_KIMI_API_KEY/);
  await assert.rejects(glm.fetch({}), /LLM_USAGE_GLM_API_KEY/);
});

test('Codex 和 Claude 可直接使用配置中的 access token', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, authorization: options.headers.Authorization });
    if (url.includes('anthropic.com')) {
      return {
        ok: true,
        json: async () => ({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_after_seconds: 3600 },
          secondary_window: null,
        },
      }),
    };
  };

  try {
    await codex.fetch({ access_token: 'codex-access-token', auth_path: '/path/that/must/not/be/read.json' });
    await claude.fetch({ access_token: 'claude-access-token' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    { url: 'https://chatgpt.com/backend-api/wham/usage', authorization: 'Bearer codex-access-token' },
    { url: 'https://api.anthropic.com/api/oauth/usage', authorization: 'Bearer claude-access-token' },
  ]);
});

test('Codex 窗口标签由服务端时长决定，不依赖 primary/secondary 字段名', () => {
  assert.equal(formatWindowLabel({ limit_window_seconds: 5 * 60 * 60 }), '5小时');
  assert.equal(formatWindowLabel({ limit_window_seconds: 7 * 24 * 60 * 60 }), '周限额');
  assert.equal(formatWindowLabel({ limit_window_seconds: 24 * 60 * 60 }), '1天');
  assert.equal(formatWindowLabel({ limit_window_seconds: 2 * 60 * 60 }), '2小时');
  assert.equal(formatWindowLabel({}), '限额');
});

test('Codex 跳过不存在的窗口，primary 为 7 天时显示周限额', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 604800, reset_after_seconds: 500000 },
        secondary_window: null,
      },
      rate_limit_reset_credits: { available_count: 1 },
    }),
  });

  try {
    const result = await codex.fetch({ access_token: 'codex-access-token' });
    assert.deepEqual(result, {
      meta: '重置券 1',
      lines: [{ label: '周限额', percent: 12, resetAfter: 500000 }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Codex 没有任何窗口时明确报错，不伪造 0% 行', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ rate_limit: {} }) });
  try {
    await assert.rejects(() => codex.fetch({ access_token: 'codex-access-token' }), /未返回可识别的额度窗口/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HTTP 错误在截断前脱敏，不泄露跨边界的凭证前缀', async () => {
  const originalFetch = globalThis.fetch;
  const secret = 'plain-secret-across-truncation-boundary';
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => `${'x'.repeat(190)}${secret}` });
  try {
    await assert.rejects(
      fetchJson('https://example.invalid', { headers: { Authorization: secret } }),
      error => !error.message.includes(secret) && !error.message.includes(secret.slice(0, 10)),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Tokscale 子进程不会继承 LLM_USAGE 环境变量', () => {
  assert.deepEqual(createTokscaleEnv({
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://proxy.example',
    LLM_USAGE_KIMI_API_KEY: 'kimi-secret',
    LLM_USAGE_CODEX_ACCESS_TOKEN: 'codex-secret',
    LLM_USAGE_GLM_COOKIE: 'cookie-secret',
  }), { PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy.example' });
});

test('额外账号实例按 type 找到实现，label 用于区分同类账号', () => {
  const config = {
    providers: {
      kimi: { enabled: true, api_key: 'key-a', label: 'Kimi (我)' },
      'kimi-2': { enabled: true, type: 'kimi', label: 'Kimi (个人)', api_key: 'key-b' },
      glm: { enabled: false, api_key: 'glm-key' },
    },
  };
  const entries = getEnabledProviders(config);
  assert.deepEqual(entries.map(e => e.name), ['kimi', 'kimi-2']);
  assert.deepEqual(entries.map(e => e.label), ['Kimi (我)', 'Kimi (个人)']);
  assert.equal(entries[0].provider, kimi);
  assert.equal(entries[1].provider, kimi);
  assert.deepEqual(entries.map(e => e.config.api_key), ['key-a', 'key-b']);
});

test('未知 provider 不会出现在启用列表里', () => {
  const config = {
    providers: {
      kimi: { enabled: true, api_key: 'key-a' },
      removed: { enabled: true, api_key: 'key-b' },
    },
  };
  assert.deepEqual(getEnabledProviders(config).map(e => e.name), ['kimi']);
});

test('未设置 label 时回落到 provider 名称，-p 可按实例名过滤', () => {
  const config = {
    providers: {
      kimi: { enabled: true, api_key: 'key-a' },
      'kimi-2': { enabled: true, type: 'kimi', api_key: 'key-b' },
    },
  };
  assert.deepEqual(getEnabledProviders(config).map(e => e.label), ['Kimi Coding', 'Kimi Coding']);
  assert.deepEqual(getEnabledProviders(config, ['kimi-2']).map(e => e.name), ['kimi-2']);
  assert.deepEqual(getEnabledProviders(config, ['nope']).map(e => e.name), []);
});

test('拿不到凭证时 claude 给出可读错误而不是未捕获异常', () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'llm-usage-noclaude-'));
  const runner = new URL('../test-support/claude-no-credentials.mjs', import.meta.url);
  try {
    const result = spawnSync(process.execPath, [runner.pathname], {
      encoding: 'utf8',
      env: { PATH: '', HOME: emptyHome },
      timeout: 15_000,
    });
    assert.equal(result.status, 0, `子进程异常退出: ${result.stderr}`);
    assert.match(result.stdout, /^REJECTED: /m);
    assert.match(result.stdout, /LLM_USAGE_CLAUDE_ACCESS_TOKEN/);
    assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection/);
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }
});
