// 本地配置面板的 HTTP 服务。只绑 127.0.0.1，全部接口用一次性 token 鉴权——
// 页面能读写 API Key，不加这层的话同机任意进程/网页都能把 Key 拿走。
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import {
  CONFIG_PATH,
  loadStoredConfig,
  resolveConfig,
  resolveProviderType,
  saveStoredConfig,
} from '../config.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { redactSecrets } from '../utils.mjs';
import {
  applyFormToStored,
  buildConfigView,
  fieldsFor,
  isBuiltinProvider,
  validateForm,
} from './schema.mjs';

const APP_HTML = new URL('./app.html', import.meta.url);
const MAX_BODY_BYTES = 1024 * 1024;
const TEST_TIMEOUT_MS = 20000;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// 只认回环地址的 Host，挡住 DNS rebinding（把某个域名解析到 127.0.0.1 后来读配置）
function isLoopbackHost(hostHeader, port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(hostHeader);
}

// 同源 fetch 会带 Origin，跨站页面的 Origin 必然不匹配；没有 Origin 的是非浏览器请求
function isSameOrigin(originHeader, port) {
  if (!originHeader) return true;
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(originHeader);
}

function backupPathFor(configPath) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  return `${configPath}.bak-${stamp}`;
}

// 表单里敏感字段传 null 表示不改动，测试连接时要把盘上的旧值补回来，
// 否则「填好 Key 之前先点测试」和「没改 Key 直接点测试」都会误报缺少配置
export function buildTestConfig(stored, entry) {
  const name = String(entry?.name ?? '').trim();
  const type = isBuiltinProvider(name) ? name : String(entry?.type ?? '').trim();
  const merged = { ...(stored?.providers?.[entry?.originalName || name] || {}) };

  for (const field of fieldsFor(type)) {
    const value = entry?.fields?.[field.key];
    if (value === null || value === undefined) continue;
    if (String(value).trim() === '') {
      delete merged[field.key];
      continue;
    }
    merged[field.key] = field.type === 'number' ? Number(value) : String(value);
  }

  return { type, config: merged };
}

function collectSecrets(stored, extra = []) {
  const fromFile = Object.entries(stored?.providers || {}).flatMap(([name, providerConfig]) => {
    const type = resolveProviderType(name, providerConfig);
    return fieldsFor(type)
      .filter(field => field.type === 'secret')
      .map(field => providerConfig?.[field.key]);
  });
  return [...fromFile, ...extra].filter(value => typeof value === 'string' && value.length > 0);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`请求超时（${ms}ms）`)), ms);
    }),
  ]);
}

async function handleGetConfig(res, { configPath, env }) {
  const stored = loadStoredConfig(configPath);
  try {
    sendJson(res, 200, buildConfigView({ stored, env, configPath }));
  } catch (error) {
    // resolveConfig 会在实例 type 写错时抛错：如实告诉用户要先手工修配置文件
    sendJson(res, 500, { error: `读取配置失败：${error.message}` });
  }
}

function handleGetSecret(res, url, { configPath }) {
  const name = url.searchParams.get('provider') || '';
  const key = url.searchParams.get('field') || '';
  const stored = loadStoredConfig(configPath);
  const providerConfig = stored?.providers?.[name];
  if (!providerConfig) {
    sendJson(res, 404, { error: `未找到 ${name}` });
    return;
  }

  const type = resolveProviderType(name, providerConfig);
  const field = fieldsFor(type).find(item => item.key === key);
  if (field?.type !== 'secret') {
    sendJson(res, 400, { error: `${key} 不是敏感字段` });
    return;
  }
  sendJson(res, 200, { value: String(providerConfig[key] ?? '') });
}

async function handleSaveConfig(req, res, { configPath }) {
  let form;
  try {
    form = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { errors: [{ path: '', message: `请求体解析失败：${error.message}` }] });
    return;
  }

  const stored = loadStoredConfig(configPath);
  const errors = validateForm(form, stored);
  if (errors.length > 0) {
    sendJson(res, 400, { errors });
    return;
  }

  const next = applyFormToStored(stored, form);
  try {
    // 落盘前先过一遍真实的解析逻辑，避免写出一份自己都读不回来的配置
    resolveConfig(next, {});
  } catch (error) {
    sendJson(res, 400, { errors: [{ path: '', message: error.message }] });
    return;
  }

  let backup = null;
  if (existsSync(configPath)) {
    backup = backupPathFor(configPath);
    copyFileSync(configPath, backup);
  }
  saveStoredConfig(next, configPath);
  sendJson(res, 200, { ok: true, configPath, backupPath: backup });
}

async function handleTestProvider(req, res, { configPath }) {
  let entry;
  try {
    entry = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { error: `请求体解析失败：${error.message}` });
    return;
  }

  const stored = loadStoredConfig(configPath);
  const { type, config } = buildTestConfig(stored, entry);
  const provider = PROVIDERS[type];
  if (!provider) {
    sendJson(res, 400, { error: `未知的 provider 类型：${type || '(空)'}` });
    return;
  }

  const secrets = collectSecrets(
    stored,
    fieldsFor(type).filter(f => f.type === 'secret').map(f => config[f.key]),
  );
  try {
    const result = await withTimeout(provider.fetch(config), TEST_TIMEOUT_MS);
    sendJson(res, 200, { ok: true, meta: result.meta || '', lines: result.lines || [] });
  } catch (error) {
    sendJson(res, 200, { ok: false, error: redactSecrets(error?.message || String(error), secrets) });
  }
}

function createHandler(context) {
  return async function handle(req, res) {
    const { port, token } = context;
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (!isLoopbackHost(req.headers.host, port)) {
      sendText(res, 403, '仅允许通过 127.0.0.1 访问');
      return;
    }

    if (url.pathname === '/') {
      if (url.searchParams.get('t') !== token) {
        sendText(res, 401, '链接无效或已过期，请重新运行 llm-usage web');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(readFileSync(APP_HTML));
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      sendText(res, 404, 'Not Found');
      return;
    }

    if (req.headers['x-auth-token'] !== token) {
      sendJson(res, 401, { error: '鉴权失败' });
      return;
    }
    if (req.method !== 'GET' && !isSameOrigin(req.headers.origin, port)) {
      sendJson(res, 403, { error: '来源不允许' });
      return;
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/config') {
        await handleGetConfig(res, context);
      } else if (req.method === 'GET' && url.pathname === '/api/secret') {
        handleGetSecret(res, url, context);
      } else if (req.method === 'POST' && url.pathname === '/api/config') {
        await handleSaveConfig(req, res, context);
      } else if (req.method === 'POST' && url.pathname === '/api/test') {
        await handleTestProvider(req, res, context);
      } else {
        sendJson(res, 404, { error: 'Not Found' });
      }
    } catch (error) {
      sendJson(res, 500, { error: redactSecrets(error?.message || String(error)) });
    }
  };
}

export function startWebServer({
  port = 0,
  host = '127.0.0.1',
  configPath = CONFIG_PATH,
  env = process.env,
} = {}) {
  const context = { token: randomBytes(24).toString('hex'), port, configPath, env };
  const server = createServer(createHandler(context));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      context.port = server.address().port;
      resolve({
        server,
        port: context.port,
        token: context.token,
        url: `http://${host}:${context.port}/?t=${context.token}`,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

export function openBrowser(url) {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // 打不开浏览器不影响服务本身，用户还能自己复制 URL
  }
}
