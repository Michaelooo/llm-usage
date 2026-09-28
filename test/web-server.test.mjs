import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadStoredConfig, saveStoredConfig } from '../src/config.mjs';
import { buildTestConfig, startWebServer } from '../src/web/server.mjs';

const baseConfig = {
  providers: {
    kimi: { enabled: true, api_key: 'sk-kimi-secret-value' },
    'kimi-2': { enabled: true, type: 'kimi', api_key: 'sk-second-secret-value' },
    glm: { enabled: true, api_key: 'glm-secret', cookie: 'cookie-secret', custom: 'keep-me' },
  },
  watch: { quota_interval_sec: 60, token_interval_sec: 900 },
};

function rawRequest(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function withServer(stored, run) {
  const configPath = join(mkdtempSync(join(tmpdir(), 'llm-usage-web-')), 'config.yaml');
  if (stored) saveStoredConfig(stored, configPath);
  const session = await startWebServer({ port: 0, configPath, env: {} });
  const call = (path, options = {}) => rawRequest(session.port, path, {
    ...options,
    headers: { 'x-auth-token': session.token, ...(options.headers || {}) },
  });
  try {
    await run({ session, configPath, call });
  } finally {
    await session.close();
  }
}

test('没有令牌的接口调用一律 401', async () => {
  await withServer(baseConfig, async ({ session }) => {
    assert.equal((await rawRequest(session.port, '/api/config')).status, 401);
    assert.equal((await rawRequest(session.port, '/')).status, 401);
    assert.equal((await rawRequest(session.port, '/api/config', { headers: { 'x-auth-token': 'nope' } })).status, 401);
  });
});

test('带令牌的页面请求返回配置面板', async () => {
  await withServer(baseConfig, async ({ session }) => {
    const page = await rawRequest(session.port, `/?t=${session.token}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /llm-usage 配置/);
    assert.equal(page.text.includes('sk-kimi-secret-value'), false);
  });
});

test('非回环 Host 被拒绝，挡住 DNS rebinding', async () => {
  await withServer(baseConfig, async ({ session }) => {
    const response = await rawRequest(session.port, '/api/config', {
      headers: { 'x-auth-token': session.token, host: 'attacker.example.com' },
    });
    assert.equal(response.status, 403);
  });
});

test('跨站来源的写请求被拒绝', async () => {
  await withServer(baseConfig, async ({ call }) => {
    const response = await call('/api/config', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 403);
  });
});

test('配置接口只返回掩码，密钥全文要单独取', async () => {
  await withServer(baseConfig, async ({ call }) => {
    const view = await call('/api/config');
    assert.equal(view.status, 200);
    assert.equal(view.text.includes('sk-kimi-secret-value'), false);
    assert.match(view.text, /sk-k••••••alue/);

    const secret = await call('/api/secret?provider=kimi&field=api_key');
    assert.deepEqual(JSON.parse(secret.text), { value: 'sk-kimi-secret-value' });
  });
});

test('非敏感字段不能走密钥接口', async () => {
  await withServer(baseConfig, async ({ call }) => {
    const response = await call('/api/secret?provider=kimi&field=missing');
    assert.equal(response.status, 400);
  });
});

test('保存会备份旧文件、写回 600 权限并保留手写字段', async () => {
  await withServer(baseConfig, async ({ call, configPath }) => {
    const response = await call('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: [
          { name: 'kimi', originalName: 'kimi', type: 'kimi', enabled: true, label: '主号', fields: { api_key: null } },
          { name: 'kimi-2', originalName: null, type: 'kimi', enabled: true, label: '小号', fields: { api_key: 'sk-second-account' } },
          { name: 'glm', originalName: 'glm', type: 'glm', enabled: true, label: '', fields: { api_key: null, cookie: null } },
        ],
        watch: { quota_interval_sec: '45', token_interval_sec: '600' },
      }),
    });

    assert.equal(response.status, 200);
    const body = JSON.parse(response.text);
    assert.equal(body.ok, true);
    assert.ok(existsSync(body.backupPath));
    assert.match(body.backupPath, /config\.yaml\.bak-\d{14}$/);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);

    const saved = loadStoredConfig(configPath);
    assert.equal(saved.providers.kimi.api_key, 'sk-kimi-secret-value');
    assert.equal(saved.providers.kimi.label, '主号');
    assert.equal(saved.providers['kimi-2'].type, 'kimi');
    assert.equal(saved.providers['kimi-2'].api_key, 'sk-second-account');
    assert.equal(saved.providers.glm.custom, 'keep-me');
    assert.deepEqual(saved.watch, { quota_interval_sec: 45, token_interval_sec: 600 });
  });
});

test('非法输入返回 400 且完全不落盘', async () => {
  await withServer(baseConfig, async ({ call, configPath }) => {
    const before = readFileSync(configPath, 'utf-8');
    const response = await call('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: [{ name: 'kimi', originalName: 'kimi', type: 'kimi', enabled: true, label: '', fields: { api_key: 'sk-with#hash' } }],
        watch: { quota_interval_sec: '60', token_interval_sec: '900' },
      }),
    });
    assert.equal(response.status, 400);
    assert.match(JSON.parse(response.text).errors[0].message, /不能包含 # 或换行/);
    assert.equal(readFileSync(configPath, 'utf-8'), before);
    assert.deepEqual(readdirSync(dirname(configPath)).filter(name => name.includes('.bak-')), []);
  });
});

test('测试连接对未知类型报错，对缺少凭证如实返回失败', async () => {
  await withServer({ providers: { kimi: { enabled: true } } }, async ({ call }) => {
    const unknown = await call('/api/test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ghost', type: 'nope', fields: {} }),
    });
    assert.equal(unknown.status, 400);

    const missingKey = await call('/api/test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'kimi', originalName: 'kimi', type: 'kimi', fields: { api_key: null } }),
    });
    assert.equal(missingKey.status, 200);
    const body = JSON.parse(missingKey.text);
    assert.equal(body.ok, false);
    assert.match(body.error, /缺少配置/);
  });
});

test('测试连接会把盘上未改动的密钥补回来', () => {
  const merged = buildTestConfig(baseConfig, {
    name: 'kimi', originalName: 'kimi', type: 'kimi', fields: { api_key: null },
  });
  assert.equal(merged.type, 'kimi');
  assert.equal(merged.config.api_key, 'sk-kimi-secret-value');
});

test('测试连接优先用表单里刚填的新密钥', () => {
  const merged = buildTestConfig(baseConfig, {
    name: 'kimi', originalName: 'kimi', type: 'kimi', fields: { api_key: 'sk-typed-just-now' },
  });
  assert.equal(merged.config.api_key, 'sk-typed-just-now');
});
