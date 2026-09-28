import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDefaultConfig,
  DEFAULT_WATCH,
  getProviderSecrets,
  hasEnvironmentConfig,
  isCiEnvironment,
  loadConfig,
  loadStoredConfig,
  MIN_QUOTA_INTERVAL_SEC,
  MIN_TOKEN_INTERVAL_SEC,
  resolveConfig,
  resolveWatchIntervals,
  saveStoredConfig,
  toYaml,
} from '../src/config.mjs';
import { redactSecrets } from '../src/utils.mjs';

const storedConfig = {
  providers: {
    kimi: { enabled: true, api_key: 'kimi-from-yaml' },
  },
};

test('环境变量覆盖 config.yaml，config.yaml 覆盖默认配置', () => {
  const config = resolveConfig(storedConfig, { LLM_USAGE_KIMI_API_KEY: 'kimi-from-env' });
  assert.equal(config.providers.kimi.api_key, 'kimi-from-env');
  assert.equal(config.providers.kimi.enabled, true);
  assert.equal(config.providers.glm.enabled, false);
  assert.equal(config.providers.glm.api_key, '');
});

test('缺失的环境变量保留 config.yaml 和默认配置', () => {
  const config = resolveConfig(storedConfig, {});
  assert.deepEqual(config.providers.kimi, storedConfig.providers.kimi);
  assert.equal(config.providers.codex.enabled, false);
  assert.equal(config.providers.codex.access_token, '');
  assert.match(config.providers.codex.auth_path, /.codex\/auth\.json$/);
});

test('空字符串环境变量视为未设置，不覆盖 config.yaml', () => {
  const config = resolveConfig(storedConfig, {
    LLM_USAGE_KIMI_API_KEY: ' ',
    LLM_USAGE_KIMI_ENABLED: '',
  });
  assert.equal(config.providers.kimi.api_key, 'kimi-from-yaml');
  assert.equal(config.providers.kimi.enabled, true);
  assert.equal(hasEnvironmentConfig({ LLM_USAGE_KIMI_API_KEY: ' ' }), false);
});

test('无效的额度刷新间隔环境变量会明确报错', () => {
  for (const value of ['0', '-1', 'NaN', 'Infinity']) {
    assert.throws(
      () => resolveConfig(storedConfig, { LLM_USAGE_WATCH_QUOTA_INTERVAL_SEC: value }),
      /LLM_USAGE_WATCH_QUOTA_INTERVAL_SEC 必须是大于 0 的数字/,
    );
  }
});

test('无效的 enabled 环境变量会报错，不会因凭证存在而自动启用', () => {
  assert.throws(
    () => resolveConfig({}, {
      LLM_USAGE_CODEX_ENABLED: 'flase',
      LLM_USAGE_CODEX_ACCESS_TOKEN: 'codex-secret',
    }),
    /LLM_USAGE_CODEX_ENABLED 仅支持/,
  );
});

test('所有 Provider 的敏感配置都可由环境变量提供并自动启用', () => {
  const config = resolveConfig({}, {
    LLM_USAGE_KIMI_API_KEY: 'kimi-secret',
    LLM_USAGE_GLM_API_KEY: 'glm-secret',
    LLM_USAGE_GLM_COOKIE: 'glm-cookie-secret',
    LLM_USAGE_CODEX_ACCESS_TOKEN: 'codex-secret',
    LLM_USAGE_CLAUDE_ACCESS_TOKEN: 'claude-secret',
  });

  for (const provider of ['kimi', 'glm', 'codex', 'claude']) {
    assert.equal(config.providers[provider].enabled, true);
  }
  assert.deepEqual(getProviderSecrets(config).sort(), [
    'claude-secret',
    'codex-secret',
    'glm-cookie-secret',
    'glm-secret',
    'kimi-secret',
  ]);
});

test('额外账号实例继承 type 的默认值，并紧跟它的 type 排列', () => {
  const config = resolveConfig({
    providers: {
      kimi: { enabled: true, api_key: 'key-a' },
      'kimi-2': { enabled: true, type: 'kimi', label: 'Kimi B', api_key: 'key-b' },
    },
  }, {});

  assert.deepEqual(config.providers['kimi-2'], {
    enabled: true,
    type: 'kimi',
    label: 'Kimi B',
    api_key: 'key-b',
  });
  assert.deepEqual(Object.keys(config.providers).slice(0, 3), ['kimi', 'kimi-2', 'glm']);
});

test('环境变量是全局单值，不覆盖额外实例，避免多账号串号', () => {
  const config = resolveConfig({
    providers: {
      kimi: { enabled: true, api_key: 'key-a' },
      'kimi-2': { enabled: true, type: 'kimi', api_key: 'key-b' },
    },
  }, { LLM_USAGE_KIMI_API_KEY: 'key-from-env' });

  assert.equal(config.providers.kimi.api_key, 'key-from-env');
  assert.equal(config.providers['kimi-2'].api_key, 'key-b');
});

test('实例的 type 缺失或无效时跳过并提示，不阻塞其他 provider', () => {
  const warnings = [];
  const originalError = console.error;
  console.error = message => warnings.push(String(message));
  let config;
  try {
    config = resolveConfig({
      providers: {
        kimi: { enabled: true, api_key: 'key-a' },
        'removed-2': { enabled: true, api_key: 'key-b' },
        'bad-2': { enabled: true, type: 'unknown' },
      },
    }, {});
  } finally {
    console.error = originalError;
  }

  assert.ok(config.providers.kimi);
  assert.equal(config.providers['removed-2'], undefined);
  assert.equal(config.providers['bad-2'], undefined);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /忽略未知 provider: removed-2/);
  assert.match(warnings[1], /忽略未知 provider: bad-2/);
});

test('额外实例的凭证也会进入脱敏名单', () => {
  const config = resolveConfig({
    providers: {
      kimi: { enabled: true, api_key: 'key-a-secret' },
      'kimi-2': { enabled: true, type: 'kimi', api_key: 'key-b-secret' },
    },
  }, {});

  assert.deepEqual(getProviderSecrets(config).sort(), ['key-a-secret', 'key-b-secret']);
  assert.equal(redactSecrets('failed for key-b-secret', getProviderSecrets(config)), 'failed for ***');
});

test('显式 enabled=false 优先于凭证自动启用', () => {
  const config = resolveConfig({}, {
    LLM_USAGE_KIMI_API_KEY: 'kimi-secret',
    LLM_USAGE_KIMI_ENABLED: 'false',
  });
  assert.equal(config.providers.kimi.enabled, false);
  assert.equal(config.providers.kimi.api_key, 'kimi-secret');
});

test('没有配置文件时，环境变量可独立生成非交互配置', () => {
  const config = loadConfig({
    configPath: '/path/that/does/not/exist/config.yaml',
    env: { LLM_USAGE_KIMI_API_KEY: 'kimi-secret' },
  });
  assert.equal(config.providers.kimi.enabled, true);
  assert.equal(config.providers.kimi.api_key, 'kimi-secret');
});

test('配置文件和环境变量都缺失时返回 null', () => {
  assert.equal(loadConfig({ configPath: '/path/that/does/not/exist/config.yaml', env: {} }), null);
});

test('YAML 解析支持 providers 之外的顶层节', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-usage-config-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, `# 注释
providers:
  kimi:
    enabled: true
    api_key: "sk-from-file"
watch:
  quota_interval_sec: 45
  token_interval_sec: 900
`);

  const stored = loadStoredConfig(path);
  assert.equal(stored.providers.kimi.enabled, true);
  assert.equal(stored.providers.kimi.api_key, 'sk-from-file');
  assert.deepEqual(stored.watch, { quota_interval_sec: 45, token_interval_sec: 900 });
});

test('默认配置写出后可以原样解析回来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-usage-config-'));
  const path = join(dir, 'config.yaml');
  const defaults = buildDefaultConfig();
  writeFileSync(path, `${toYaml(defaults)}\n`);
  assert.deepEqual(loadStoredConfig(path), defaults);
});

test('saveStoredConfig 整份重写后可解析，watch 节保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-usage-config-'));
  const path = join(dir, 'config.yaml');
  const stored = {
    providers: { kimi: { enabled: true, api_key: 'kimi-key' } },
    watch: { quota_interval_sec: 45, token_interval_sec: 900 },
  };

  saveStoredConfig(stored, path);
  assert.deepEqual(loadStoredConfig(path), stored);
});

test('刷新间隔遵循 CLI > 环境变量 > 文件 > 默认值，并夹到下限', () => {
  const fromFile = resolveConfig({ watch: { quota_interval_sec: 45 } }, {});
  assert.equal(resolveWatchIntervals(fromFile).quotaIntervalSec, 45);

  const fromEnv = resolveConfig(
    { watch: { quota_interval_sec: 45 } },
    { LLM_USAGE_WATCH_QUOTA_INTERVAL_SEC: '90' },
  );
  assert.equal(resolveWatchIntervals(fromEnv).quotaIntervalSec, 90, '环境变量应覆盖文件');
  assert.equal(
    resolveWatchIntervals(fromEnv, { quotaIntervalSec: 20 }).quotaIntervalSec,
    20,
    'CLI 应覆盖环境变量',
  );

  const clamped = resolveWatchIntervals({}, { quotaIntervalSec: 1, tokenIntervalSec: 5 });
  assert.equal(clamped.quotaIntervalSec, MIN_QUOTA_INTERVAL_SEC);
  assert.equal(clamped.tokenIntervalSec, MIN_TOKEN_INTERVAL_SEC);
});

test('未配置 watch 时回落到默认刷新间隔', () => {
  const config = resolveConfig({}, {});
  assert.deepEqual(config.watch, DEFAULT_WATCH);
  assert.deepEqual(resolveWatchIntervals(config), { quotaIntervalSec: 60, tokenIntervalSec: 900 });
});

test('CI 环境禁止自动进入交互配置', () => {
  assert.equal(isCiEnvironment({ CI: 'true' }), true);
  assert.equal(isCiEnvironment({ CI: '1' }), true);
  assert.equal(isCiEnvironment({ CI: 'false' }), false);
  assert.equal(isCiEnvironment({}), false);
});

test('错误文本会脱敏显式 Key、Bearer Token 和 Cookie', () => {
  const secrets = ['plain-api-key', 'oauth-token'];
  const message = 'api_key=plain-api-key Authorization: Bearer oauth-token cookie=acw_tc=cookie-secret';
  const redacted = redactSecrets(message, secrets);

  assert.equal(redacted.includes('plain-api-key'), false);
  assert.equal(redacted.includes('oauth-token'), false);
  assert.equal(redacted.includes('cookie-secret'), false);
  assert.match(redacted, /api_key=\*\*\*/);
});
