import { redactSecrets } from './utils.mjs';

export const MAX_EVENTS = 5;

// ---------------------------------------------------------------------------
// 状态：纯数据 + 纯函数，渲染只读它，不感知任何飞行中的请求
// ---------------------------------------------------------------------------

function baseProviderEntry({ name, type, provider, label }) {
  return {
    name,
    // 渲染按 type 分组对齐同一实现的多个账号
    type: type || name,
    label: label || provider.name,
    color: provider.color,
    result: null,
    prev: null,
    error: null,
    at: null,
  };
}

export function createInitialState(entries, startedAt) {
  return {
    startedAt,
    round: 0,
    quota: { pending: false, lastAt: null, nextAt: null },
    token: { report: null, error: null, pending: false, lastAt: null, nextAt: null },
    providers: entries.map(baseProviderEntry),
    events: [],
  };
}

// 配置热重载：按 name 对齐新旧列表。存活的 provider 必须保留已取到的数字，
// 否则改一次配置整块看板就闪回空白，增量（prev）也会断档。
export function reconcileProviders(state, entries) {
  const previous = new Map(state.providers.map(entry => [entry.name, entry]));
  state.providers = entries.map(entry => {
    const base = baseProviderEntry(entry);
    const kept = previous.get(entry.name);
    if (!kept) return base;
    return { ...base, result: kept.result, prev: kept.prev, error: kept.error, at: kept.at };
  });
  return state;
}

function findProvider(state, name) {
  return state.providers.find(entry => entry.name === name);
}

export function applyQuotaResult(state, name, result, at) {
  const entry = findProvider(state, name);
  if (!entry) return state;
  // 上一轮成功值留作 delta 基准；失败不覆盖，保证画面始终有数
  entry.prev = entry.result;
  entry.result = result;
  entry.error = null;
  entry.at = at;
  return state;
}

export function applyQuotaError(state, name, error, at) {
  const entry = findProvider(state, name);
  if (!entry) return state;
  entry.error = { message: error?.message || String(error), at };
  return state;
}

export function applyTokenResult(state, report, at) {
  state.token.report = report;
  state.token.error = null;
  state.token.lastAt = at;
  return state;
}

export function applyTokenError(state, error, at) {
  state.token.error = { message: error?.message || String(error), at };
  state.token.lastAt = state.token.lastAt ?? at;
  return state;
}

export function pushEvent(state, text, at, kind = 'info') {
  state.events.push({ at, text, kind });
  if (state.events.length > MAX_EVENTS) state.events.shift();
  return state;
}

// 有 result 但 error 非空 = 展示的是上一轮的旧值
export function isStale(entry) {
  return Boolean(entry.result && entry.error);
}

// ---------------------------------------------------------------------------
// 调度：双节奏 + 重叠保护
// ---------------------------------------------------------------------------

export function createWatcher({
  entries,
  secrets = [],
  quotaIntervalSec,
  tokenIntervalSec,
  fetchTokenUsage,
  onChange = () => {},
  now = Date.now,
}) {
  const quotaIntervalMs = quotaIntervalSec * 1000;
  const tokenIntervalMs = tokenIntervalSec * 1000;
  const state = createInitialState(entries, now());
  state.quota.nextAt = state.startedAt;
  state.token.nextAt = state.startedAt;

  // 配置可以在运行期被换掉，脱敏名单必须跟着换，否则新 Key 不会被遮住
  let currentEntries = entries;
  let currentSecrets = secrets;

  const safeMessage = value => redactSecrets(value?.message || String(value), currentSecrets);

  async function refreshQuota() {
    // 重叠保护：上一轮没跑完就跳过本轮，慢网络下不堆积请求
    if (state.quota.pending) return;
    state.quota.pending = true;
    state.round += 1;
    onChange();

    await Promise.all(currentEntries.map(async ({ name, provider, config: providerConfig }) => {
      try {
        const result = await provider.fetch(providerConfig);
        applyQuotaResult(state, name, result, now());
        onChange();
      } catch (error) {
        applyQuotaError(state, name, new Error(safeMessage(error)), now());
      }
      onChange();
    }));

    const at = now();
    state.quota.pending = false;
    state.quota.lastAt = at;
    state.quota.nextAt = at + quotaIntervalMs;
    onChange();
  }

  async function refreshToken() {
    if (state.token.pending) return;
    state.token.pending = true;
    onChange();

    try {
      applyTokenResult(state, await fetchTokenUsage(), now());
    } catch (error) {
      applyTokenError(state, new Error(safeMessage(error)), now());
    }

    const at = now();
    state.token.pending = false;
    state.token.nextAt = at + tokenIntervalMs;
    onChange();
  }

  // 配置文件变更后换掉 provider 列表和脱敏名单。飞行中的请求不打断：
  // 它们回来时 applyQuotaResult 找不到对应 entry 就自然丢弃。
  function updateEntries(nextEntries, nextSecrets = currentSecrets) {
    currentEntries = nextEntries;
    currentSecrets = nextSecrets;
    reconcileProviders(state, nextEntries);
    onChange();
    return state;
  }

  return { state, refreshQuota, refreshToken, updateEntries, quotaIntervalMs, tokenIntervalMs };
}
