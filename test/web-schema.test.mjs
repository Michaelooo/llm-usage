import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStoredConfig, saveStoredConfig } from '../src/config.mjs';
import { applyFormToStored, buildConfigView, maskSecret, validateForm } from '../src/web/schema.mjs';

const stored = {
  providers: {
    kimi: { enabled: true, api_key: 'sk-kimi-secret-value' },
    'kimi-2': { enabled: true, type: 'kimi', label: 'Kimi B', api_key: 'sk-second-secret-value' },
    glm: { enabled: true, api_key: 'glm-secret', cookie: 'cookie-secret' },
  },
  watch: { quota_interval_sec: 60, token_interval_sec: 900 },
};

function providerIn(view, name) {
  return view.providers.find(entry => entry.name === name);
}

function fieldIn(provider, key) {
  return provider.fields.find(field => field.key === key);
}

function formFrom(overrides = {}) {
  return {
    providers: [
      { name: 'kimi', originalName: 'kimi', type: 'kimi', enabled: true, label: '', fields: { api_key: null } },
      ...(overrides.providers || []),
    ],
    watch: { quota_interval_sec: '60', token_interval_sec: '900' },
    ...overrides.top,
  };
}

test('配置视图不下发密钥全文，只给可辨认的掩码', () => {
  const view = buildConfigView({ stored, env: {}, configPath: '/tmp/config.yaml' });
  const apiKey = fieldIn(providerIn(view, 'kimi'), 'api_key');
  assert.equal(apiKey.value, '');
  assert.equal(apiKey.hasValue, true);
  assert.equal(apiKey.masked, 'sk-k••••••alue');
  assert.equal(JSON.stringify(view).includes('sk-kimi-secret-value'), false);
});

test('掩码短值不泄露长度以外的信息', () => {
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('abc'), '•••');
  assert.equal(maskSecret('abcdefghij'), 'abcd••••••ghij');
});

test('内置 provider 标注环境变量覆盖，额外实例不标注', () => {
  const view = buildConfigView({
    stored,
    env: { LLM_USAGE_KIMI_API_KEY: 'from-env' },
    configPath: '/tmp/config.yaml',
  });
  assert.equal(fieldIn(providerIn(view, 'kimi'), 'api_key').overriddenBy, 'LLM_USAGE_KIMI_API_KEY');
  assert.equal(fieldIn(providerIn(view, 'kimi-2'), 'api_key').overriddenBy, null);
});

test('未配置的 provider 也出现在视图里，且顺序与看板一致', () => {
  const view = buildConfigView({ stored, env: {}, configPath: '/tmp/config.yaml' });
  assert.deepEqual(view.providers.map(entry => entry.name), ['kimi', 'kimi-2', 'glm', 'codex', 'claude']);
  assert.equal(providerIn(view, 'codex').enabled, false);
});

test('配置含未知 provider 时表单跳过它而不是抛错', () => {
  const view = buildConfigView({
    stored: { providers: { kimi: { enabled: true, api_key: 'key' }, removed: { enabled: true } } },
    env: {},
    configPath: '/tmp/config.yaml',
  });
  assert.deepEqual(view.providers.map(entry => entry.name), ['kimi', 'glm', 'codex', 'claude']);
});

test('保存保留表单管不到的手写字段', () => {
  const withCustom = {
    ...stored,
    providers: { ...stored.providers, kimi: { ...stored.providers.kimi, custom: 'keep-me' } },
  };
  const next = applyFormToStored(withCustom, formFrom());
  assert.equal(next.providers.kimi.custom, 'keep-me');
});

test('敏感字段传 null 保留旧值，传空串才清空', () => {
  const kept = applyFormToStored(stored, formFrom());
  assert.equal(kept.providers.kimi.api_key, 'sk-kimi-secret-value');

  const cleared = applyFormToStored(stored, {
    providers: [{ name: 'kimi', originalName: 'kimi', type: 'kimi', enabled: false, label: '', fields: { api_key: '' } }],
    watch: {},
  });
  assert.equal(cleared.providers.kimi.api_key, '');
});

test('重命名实例时按原名取回未改动的密钥', () => {
  const next = applyFormToStored(stored, {
    providers: [{
      name: 'kimi-b', originalName: 'kimi-2', type: 'kimi', enabled: true, label: 'Kimi B', fields: { api_key: null },
    }],
    watch: {},
  });
  assert.equal(next.providers['kimi-b'].api_key, 'sk-second-secret-value');
  assert.equal(next.providers['kimi-b'].type, 'kimi');
  assert.equal(next.providers['kimi-2'], undefined);
});

test('表单里不存在的实例视为删除', () => {
  const next = applyFormToStored(stored, formFrom());
  assert.equal(next.providers['kimi-2'], undefined);
  assert.equal(Object.keys(next.providers).length, 1);
});

test('内置 provider 不写 type，额外实例必须写 type', () => {
  const next = applyFormToStored(stored, {
    providers: [
      { name: 'kimi', originalName: 'kimi', type: 'kimi', enabled: true, label: '', fields: {} },
      { name: 'kimi-3', originalName: null, type: 'kimi', enabled: true, label: '', fields: { api_key: 'k3' } },
    ],
    watch: {},
  });
  assert.equal('type' in next.providers.kimi, false);
  assert.equal(next.providers['kimi-3'].type, 'kimi');
});

test('拒绝会损坏 YAML 的 # 和换行', () => {
  const withHash = validateForm({
    providers: [{ name: 'kimi', originalName: 'kimi', type: 'kimi', enabled: true, label: '', fields: { api_key: 'sk-ab#cd' } }],
    watch: {},
  }, stored);
  assert.equal(withHash.length, 1);
  assert.match(withHash[0].message, /不能包含 # 或换行/);

  const withNewline = validateForm({
    providers: [{ name: 'kimi', originalName: 'kimi', type: 'kimi', enabled: true, label: '', fields: { api_key: 'sk-a\nb' } }],
    watch: {},
  }, stored);
  assert.equal(withNewline.length, 1);
});

test('拒绝非法实例名、重名和无效类型', () => {
  const errors = validateForm({
    providers: [
      { name: 'ki mi', originalName: null, type: 'kimi', enabled: false, label: '', fields: {} },
      { name: 'kimi', originalName: 'kimi', type: 'kimi', enabled: false, label: '', fields: {} },
      { name: 'kimi', originalName: 'kimi', type: 'kimi', enabled: false, label: '', fields: {} },
      { name: 'ghost', originalName: null, type: 'nope', enabled: false, label: '', fields: {} },
    ],
    watch: {},
  }, stored);
  const messages = errors.map(error => error.message).join('\n');
  assert.match(messages, /只能包含字母、数字/);
  assert.match(messages, /重复/);
  assert.match(messages, /类型无效/);
});

test('必填校验按「表单值 + 盘上旧值」算生效值', () => {
  assert.deepEqual(validateForm(formFrom(), stored), []);
  const errors = validateForm({
    providers: [{ name: 'kimi', originalName: 'new-kimi', type: 'kimi', enabled: true, label: '', fields: { api_key: '' } }],
    watch: {},
  }, stored);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, 'kimi.api_key');
  assert.deepEqual(validateForm({
    providers: [{ name: 'kimi', originalName: 'kimi', type: 'kimi', enabled: false, label: '', fields: { api_key: '' } }],
    watch: {},
  }, stored), []);
});

test('刷新间隔的下限会被拦下', () => {
  const errors = validateForm({
    providers: [{ name: 'kimi', originalName: 'kimi', type: 'kimi', enabled: true, label: '', fields: { api_key: null } }],
    watch: { quota_interval_sec: '5', token_interval_sec: '30' },
  }, stored);
  const paths = errors.map(error => error.path);
  assert.ok(paths.includes('watch.quota_interval_sec'));
  assert.ok(paths.includes('watch.token_interval_sec'));
});

test('保存结果能被现有解析器原样读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-usage-web-'));
  const path = join(dir, 'config.yaml');
  const next = applyFormToStored(stored, {
    providers: [
      { name: 'kimi', originalName: 'kimi', type: 'kimi', enabled: true, label: '', fields: { api_key: 'sk-new"quoted' } },
      { name: 'kimi-2', originalName: 'kimi-2', type: 'kimi', enabled: true, label: 'Kimi B', fields: { api_key: null } },
    ],
    watch: { quota_interval_sec: '45', token_interval_sec: '600' },
  });
  saveStoredConfig(next, path);
  assert.deepEqual(loadStoredConfig(path), next);
  assert.equal(loadStoredConfig(path).providers.kimi.api_key, 'sk-new"quoted');
  assert.equal(loadStoredConfig(path).providers['kimi-2'].api_key, 'sk-second-secret-value');
});
