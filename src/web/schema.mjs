// 表单元信息：把 config.mjs 里的默认值/环境变量映射，和只有人类才需要的
// 中文名与帮助文本组装成一份可渲染的 schema。这里不复制字段定义，
// 默认值仍以 DEFAULT_PROVIDERS 为准，环境变量名仍以 ENV_CONFIG 为准。
import {
  DEFAULT_WATCH,
  ENV_CONFIG,
  MIN_QUOTA_INTERVAL_SEC,
  MIN_TOKEN_INTERVAL_SEC,
  WATCH_ENV_CONFIG,
  resolveConfig,
  resolveProviderType,
} from '../config.mjs';
import { PROVIDERS } from '../providers/index.mjs';

// 每个 provider 实现在表单上出现的字段（enabled 和 label 是所有 provider 的公共项，
// 单独处理，不列在这里）。顺序即渲染顺序。
export const PROVIDER_FIELDS = {
  kimi: [
    { key: 'api_key', label: 'API Key', type: 'secret', required: true, help: 'Kimi Coding 的 API Key' },
  ],
  glm: [
    { key: 'api_key', label: 'API Key', type: 'secret', required: true, help: 'Authorization 头里的字符串' },
    { key: 'cookie', label: 'Cookie', type: 'secret', help: '部分账号需要 acw_tc cookie，没有可留空' },
  ],
  codex: [
    { key: 'access_token', label: 'Access Token', type: 'secret', help: '留空则从下面的 auth.json 读取' },
    { key: 'auth_path', label: 'auth.json 路径', type: 'text', help: 'Codex CLI 的凭证文件位置' },
  ],
  claude: [
    { key: 'access_token', label: 'Access Token', type: 'secret', help: '留空则读取 macOS Keychain / ~/.claude/.credentials.json' },
  ],
};

export const WATCH_FIELDS = [
  {
    key: 'quota_interval_sec',
    label: '额度刷新间隔',
    unit: '秒',
    min: MIN_QUOTA_INTERVAL_SEC,
    help: '一次 HTTP 请求，可以快一些',
  },
  {
    key: 'token_interval_sec',
    label: 'Token 统计间隔',
    unit: '秒',
    min: MIN_TOKEN_INTERVAL_SEC,
    help: '要扫本地会话文件，耗时 3~10 秒，不宜太频繁',
  },
];

export const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
// 现有 YAML 解析器按 # 截断整行、且不转义换行，这两类字符落盘会静默损坏配置
const UNSAFE_VALUE_PATTERN = /[#\n\r]/;

export function isBuiltinProvider(name) {
  return Object.hasOwn(PROVIDER_FIELDS, name);
}

export function fieldsFor(type) {
  return PROVIDER_FIELDS[type] || [];
}

// 掩码只用于展示：保留头尾便于辨认是哪个 Key，中间一律打点
export function maskSecret(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 8) return '•'.repeat(text.length);
  return `${text.slice(0, 4)}${'•'.repeat(6)}${text.slice(-4)}`;
}

function envOverrideOf(env, type, fieldKey, builtin) {
  // 额外实例只读 config.yaml，环境变量对它们没有影响，不该提示被覆盖
  if (!builtin) return null;
  const name = ENV_CONFIG[type]?.[fieldKey]?.name;
  if (!name) return null;
  return env[name]?.trim() ? name : null;
}

function envVarOf(type, fieldKey, builtin) {
  return builtin ? ENV_CONFIG[type]?.[fieldKey]?.name || null : null;
}

// 页面需要的完整视图：值取「文件值 + 默认值」，环境变量只用来标注覆盖状态，
// 不混进 value——否则用户会以为 env 的值已经写进文件了。
export function buildConfigView({ stored, env = {}, configPath }) {
  const merged = resolveConfig(stored || {}, {}).providers;

  const providers = Object.entries(merged).map(([name, providerConfig]) => {
    const type = resolveProviderType(name, providerConfig);
    const builtin = isBuiltinProvider(name);

    return {
      name,
      // 页面允许改实例名，改完之后仍要按原名去盘上取未改动的旧值
      originalName: name,
      type,
      builtin,
      typeName: PROVIDERS[type]?.name || type,
      enabled: providerConfig.enabled === true,
      enabledEnvVar: envVarOf(type, 'enabled', builtin),
      enabledOverriddenBy: envOverrideOf(env, type, 'enabled', builtin),
      label: providerConfig.label || '',
      fields: fieldsFor(type).map(field => {
        const raw = providerConfig[field.key];
        const hasValue = raw !== undefined && raw !== null && String(raw) !== '';
        return {
          ...field,
          hasValue,
          // 敏感值绝不进首屏响应，点「显示」才走 /api/secret 单独取
          value: field.type === 'secret' ? '' : (hasValue ? String(raw) : ''),
          masked: field.type === 'secret' ? maskSecret(raw) : '',
          envVar: envVarOf(type, field.key, builtin),
          overriddenBy: envOverrideOf(env, type, field.key, builtin),
        };
      }),
    };
  });

  const storedWatch = { ...DEFAULT_WATCH, ...(stored?.watch || {}) };
  const watch = WATCH_FIELDS.map(field => ({
    ...field,
    value: storedWatch[field.key],
    envVar: WATCH_ENV_CONFIG[field.key]?.name || null,
    overriddenBy: env[WATCH_ENV_CONFIG[field.key]?.name]?.trim()
      ? WATCH_ENV_CONFIG[field.key].name
      : null,
  }));

  return {
    configPath,
    providers,
    watch,
    types: Object.keys(PROVIDER_FIELDS).map(type => ({
      type,
      name: PROVIDERS[type]?.name || type,
    })),
  };
}

function checkText(errors, path, value, label) {
  if (typeof value !== 'string') return;
  if (UNSAFE_VALUE_PATTERN.test(value)) {
    errors.push({ path, message: `${label} 不能包含 # 或换行（当前配置文件格式无法安全保存这两类字符）` });
  }
}

// 保存前的全部校验。返回空数组表示可以落盘。
// 敏感字段可以传 null 表示「不改动」，所以必填校验要拿盘上的旧值一起算生效值。
export function validateForm(form, stored) {
  const errors = [];
  const providers = Array.isArray(form?.providers) ? form.providers : [];
  const seen = new Set();

  for (const entry of providers) {
    const name = String(entry?.name ?? '').trim();
    const builtin = isBuiltinProvider(name);
    const type = builtin ? name : String(entry?.type ?? '').trim();

    if (!name) {
      errors.push({ path: '', message: '账号实例的名称不能为空' });
      continue;
    }
    if (!PROVIDER_NAME_PATTERN.test(name)) {
      errors.push({ path: name, message: `名称 ${name} 只能包含字母、数字、下划线和短横线` });
      continue;
    }
    if (seen.has(name)) {
      errors.push({ path: name, message: `名称 ${name} 重复` });
      continue;
    }
    seen.add(name);

    if (!builtin && !PROVIDER_FIELDS[type]) {
      errors.push({
        path: `${name}.type`,
        message: `${name} 的类型无效，可用值：${Object.keys(PROVIDER_FIELDS).join('、')}`,
      });
      continue;
    }

    checkText(errors, `${name}.label`, entry.label ?? '', '显示名');

    for (const field of fieldsFor(type)) {
      const value = entry?.fields?.[field.key];
      // null / undefined 表示「这个字段没被改动」，生效值取盘上的旧值
      const untouched = value === null || value === undefined;
      const effective = untouched
        ? stored?.providers?.[entry.originalName || name]?.[field.key]
        : value;

      if (field.required && entry.enabled === true && String(effective ?? '').trim() === '') {
        errors.push({
          path: `${name}.${field.key}`,
          message: `${entry.label || name} 已启用，${field.label} 不能为空`,
        });
      }
      if (untouched) continue;

      if (field.type === 'number') {
        if (String(value).trim() === '') continue;
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0) {
          errors.push({ path: `${name}.${field.key}`, message: `${field.label} 必须是大于 0 的数字` });
        }
        continue;
      }

      checkText(errors, `${name}.${field.key}`, String(value), field.label);
    }
  }

  for (const field of WATCH_FIELDS) {
    const value = form?.watch?.[field.key];
    if (value === null || value === undefined || String(value).trim() === '') continue;
    const number = Number(value);
    if (!Number.isInteger(number) || number < field.min) {
      errors.push({ path: `watch.${field.key}`, message: `${field.label} 必须是不小于 ${field.min} 的整数` });
    }
  }

  return errors;
}

// 表单 -> 待落盘的 stored 结构。以盘上内容为基底，只覆盖表单管得到的键，
// 手写的未知字段（base_url 之类）原样保留。
export function applyFormToStored(stored, form) {
  const previousProviders = stored?.providers || {};
  const providers = {};

  for (const entry of form?.providers || []) {
    const name = String(entry.name).trim();
    const builtin = isBuiltinProvider(name);
    const type = builtin ? name : String(entry.type).trim();
    const previous = previousProviders[entry.originalName || name] || {};
    const next = { ...previous };

    next.enabled = entry.enabled === true;
    if (builtin) delete next.type;
    else next.type = type;

    const label = String(entry.label ?? '').trim();
    if (label) next.label = label;
    else delete next.label;

    for (const field of fieldsFor(type)) {
      const value = entry?.fields?.[field.key];
      if (value === null || value === undefined) continue;

      if (field.type === 'number') {
        if (String(value).trim() === '') delete next[field.key];
        else next[field.key] = Number(value);
        continue;
      }
      next[field.key] = String(value);
    }

    providers[name] = next;
  }

  const watch = { ...DEFAULT_WATCH, ...(stored?.watch || {}) };
  for (const field of WATCH_FIELDS) {
    const value = form?.watch?.[field.key];
    if (value === null || value === undefined || String(value).trim() === '') continue;
    watch[field.key] = Number(value);
  }

  return { ...(stored || {}), providers, watch };
}
