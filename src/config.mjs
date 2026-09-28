import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const CONFIG_DIR = join(homedir(), '.config/llm-usage');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml');

// 预设 provider 模板：key 留空，enabled 默认 false
export const DEFAULT_PROVIDERS = {
  kimi: {
    enabled: false,
    api_key: '',
  },
  glm: {
    enabled: false,
    api_key: '',
    cookie: '',
  },
  codex: {
    enabled: false,
    access_token: '',
    auth_path: join(homedir(), '.codex/auth.json'),
  },
  claude: {
    enabled: false,
    access_token: '',
  },
};

// watch 为顶层配置节：刷新节奏是全局行为，不属于任何单个 provider
export const DEFAULT_WATCH = {
  quota_interval_sec: 60,
  token_interval_sec: 900,
};

// 下限防误配：额度是一个 HTTP 请求，Token 是 3~10s 的子进程扫描
export const MIN_QUOTA_INTERVAL_SEC = 10;
export const MIN_TOKEN_INTERVAL_SEC = 60;

export const WATCH_ENV_CONFIG = {
  quota_interval_sec: { name: 'LLM_USAGE_WATCH_QUOTA_INTERVAL_SEC', type: 'positiveNumber' },
  token_interval_sec: { name: 'LLM_USAGE_WATCH_TOKEN_INTERVAL_SEC', type: 'positiveNumber' },
};

export const ENV_CONFIG = {
  kimi: {
    enabled: { name: 'LLM_USAGE_KIMI_ENABLED', type: 'boolean' },
    api_key: { name: 'LLM_USAGE_KIMI_API_KEY', enablesProvider: true, sensitive: true },
  },
  glm: {
    enabled: { name: 'LLM_USAGE_GLM_ENABLED', type: 'boolean' },
    api_key: { name: 'LLM_USAGE_GLM_API_KEY', enablesProvider: true, sensitive: true },
    cookie: { name: 'LLM_USAGE_GLM_COOKIE', sensitive: true },
  },
  codex: {
    enabled: { name: 'LLM_USAGE_CODEX_ENABLED', type: 'boolean' },
    access_token: { name: 'LLM_USAGE_CODEX_ACCESS_TOKEN', enablesProvider: true, sensitive: true },
    auth_path: { name: 'LLM_USAGE_CODEX_AUTH_PATH', enablesProvider: true },
  },
  claude: {
    enabled: { name: 'LLM_USAGE_CLAUDE_ENABLED', type: 'boolean' },
    access_token: { name: 'LLM_USAGE_CLAUDE_ACCESS_TOKEN', enablesProvider: true, sensitive: true },
  },
};

export function toYaml(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  const lines = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) {
      lines.push(`${pad}${key}:`);
    } else if (typeof val === 'object' && !Array.isArray(val)) {
      lines.push(`${pad}${key}:`);
      lines.push(toYaml(val, indent + 1));
    } else if (typeof val === 'string') {
      lines.push(`${pad}${key}: "${val.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${pad}${key}: ${val}`);
    }
  }
  return lines.join('\n');
}

function parseScalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

// 按缩进维护容器栈，支持任意顶层键（providers / watch / 未来新增的节）
function parseYaml(text) {
  const root = {};
  const stack = [root];

  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0];
    if (!line.trim()) continue;

    const keyMatch = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
    if (!keyMatch) continue;

    const [, spaces, key, value] = keyMatch;
    const depth = spaces.length / 2;
    // 缩进不是 2 的倍数，或父层还没出现过 —— 跳过而不是猜测归属
    if (!Number.isInteger(depth)) continue;
    const parent = stack[depth];
    if (!parent) continue;

    if (value === '') {
      const section = {};
      parent[key] = section;
      stack.length = depth + 1;
      stack.push(section);
      continue;
    }

    parent[key] = parseScalar(value);
  }

  return root;
}

export function buildDefaultConfig() {
  return {
    providers: Object.fromEntries(
      Object.entries(DEFAULT_PROVIDERS).map(([name, provider]) => [name, { ...provider }]),
    ),
    watch: { ...DEFAULT_WATCH },
  };
}

export function writeDefaultConfig() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const yaml = `# LLM Usage 配置文件
# 请把对应 provider 的 enabled 改为 true，并填写 key/cookie。
# 本文件权限已设置为 600，请勿提交到 Git。

${toYaml(buildDefaultConfig())}
`;
  writeFileSync(CONFIG_PATH, yaml, 'utf-8');
  try { chmodSync(CONFIG_PATH, 0o600); } catch {}
  return CONFIG_PATH;
}

export function loadStoredConfig(configPath = CONFIG_PATH) {
  if (!existsSync(configPath)) {
    return null;
  }
  const text = readFileSync(configPath, 'utf-8');
  return parseYaml(text);
}

// 与 --setup 一致的整份重写：文件里的注释不保留，只写固定头部
export function saveStoredConfig(stored, configPath = CONFIG_PATH) {
  const yaml = `# LLM Usage 配置文件
# 本文件权限已设置为 600，请勿提交到 Git。

${toYaml(stored)}
`;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, yaml, 'utf-8');
  try { chmodSync(configPath, 0o600); } catch {}
  return configPath;
}

function parseEnvValue(value, type, name) {
  const normalized = value?.trim();
  if (!normalized) return undefined;

  if (type === 'boolean') {
    if (['1', 'true', 'yes', 'on'].includes(normalized.toLowerCase())) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized.toLowerCase())) return false;
    throw new Error(`${name} 仅支持 true/false、1/0、yes/no、on/off`);
  }

  if (type === 'number' || type === 'positiveNumber') {
    const number = Number(normalized);
    if (!Number.isFinite(number) || (type === 'positiveNumber' && number <= 0)) {
      throw new Error(`${name} 必须是大于 0 的数字`);
    }
    return number;
  }

  return normalized;
}

export function hasEnvironmentConfig(env = process.env) {
  return Object.values(ENV_CONFIG).some(fields =>
    Object.values(fields).some(({ name, type }) => parseEnvValue(env[name], type, name) !== undefined),
  );
}

export function isCiEnvironment(env = process.env) {
  const value = env.CI?.trim().toLowerCase();
  return Boolean(value && !['0', 'false', 'no', 'off'].includes(value));
}

// 同一个 provider 实现可以有多个账号实例：config.yaml 里用任意键名 + type 指向实现，
// 例如 claude-2 { type: claude }。type 缺省时键名本身就是实现名。
export function resolveProviderType(name, providerConfig) {
  return providerConfig?.type || name;
}

export function resolveConfig(storedConfig = {}, env = process.env) {
  const defaults = buildDefaultConfig().providers;
  const storedProviders = storedConfig?.providers || {};
  const providers = {};

  for (const [providerName, defaultProvider] of Object.entries(defaults)) {
    const fields = ENV_CONFIG[providerName];
    const storedProvider = storedProviders[providerName] || {};
    const environmentOverrides = {};
    let shouldEnableFromCredential = false;
    let hasExplicitEnabled = false;

    for (const [fieldName, definition] of Object.entries(fields)) {
      const value = parseEnvValue(env[definition.name], definition.type, definition.name);
      if (value === undefined) continue;
      environmentOverrides[fieldName] = value;
      if (fieldName === 'enabled') hasExplicitEnabled = true;
      if (definition.enablesProvider) shouldEnableFromCredential = true;
    }

    if (shouldEnableFromCredential && !hasExplicitEnabled) {
      environmentOverrides.enabled = true;
    }

    providers[providerName] = {
      ...defaultProvider,
      ...storedProvider,
      ...environmentOverrides,
    };

    // 额外实例紧跟它的 type 插入，看板上同类账号才会相邻。
    // 环境变量是全局单值，让它同时覆盖多个实例只会串号，所以实例只读 config.yaml。
    for (const [instanceName, storedInstance] of Object.entries(storedProviders)) {
      if (defaults[instanceName]) continue;
      if (storedInstance?.type !== providerName) continue;
      providers[instanceName] = { ...defaultProvider, ...storedInstance };
    }
  }

  // 配置文件也可能从其他版本迁移：未知段落跳过并提示，不能阻塞其余 provider。
  for (const instanceName of Object.keys(storedProviders)) {
    if (providers[instanceName]) continue;
    console.error(
      `忽略未知 provider: ${instanceName}（type 缺失或无效，可用值 ${Object.keys(defaults).join(', ')}）`,
    );
  }

  return { providers, watch: resolveWatchSection(storedConfig?.watch, env) };
}

function resolveWatchSection(storedWatch, env) {
  const merged = { ...DEFAULT_WATCH, ...(storedWatch || {}) };
  for (const [fieldName, definition] of Object.entries(WATCH_ENV_CONFIG)) {
    const value = parseEnvValue(env[definition.name], definition.type, definition.name);
    if (value !== undefined) merged[fieldName] = value;
  }
  return merged;
}

// CLI 覆盖 > 环境变量 > config.yaml > 默认值，最后统一夹到下限
export function resolveWatchIntervals(config, overrides = {}) {
  const watch = { ...DEFAULT_WATCH, ...(config?.watch || {}) };
  const quota = overrides.quotaIntervalSec ?? watch.quota_interval_sec;
  const token = overrides.tokenIntervalSec ?? watch.token_interval_sec;
  return {
    quotaIntervalSec: Math.max(MIN_QUOTA_INTERVAL_SEC, Number(quota) || DEFAULT_WATCH.quota_interval_sec),
    tokenIntervalSec: Math.max(MIN_TOKEN_INTERVAL_SEC, Number(token) || DEFAULT_WATCH.token_interval_sec),
  };
}

export function loadConfig({ configPath = CONFIG_PATH, env = process.env } = {}) {
  const storedConfig = loadStoredConfig(configPath);
  if (!storedConfig && !hasEnvironmentConfig(env)) return null;
  return resolveConfig(storedConfig || {}, env);
}

export function getProviderSecrets(config) {
  if (!config) return [];
  return Object.entries(config.providers || {})
    .flatMap(([name, providerConfig]) => {
      const fields = ENV_CONFIG[resolveProviderType(name, providerConfig)];
      if (!fields) return [];
      return Object.entries(fields)
        .filter(([, definition]) => definition.sensitive)
        .map(([fieldName]) => providerConfig?.[fieldName]);
    })
    .filter(value => typeof value === 'string' && value.length > 0);
}

export function getProviderConfig(config, name) {
  return config?.providers?.[name] || {};
}

export function ensureConfig() {
  if (!existsSync(CONFIG_PATH)) {
    writeDefaultConfig();
  }
}
