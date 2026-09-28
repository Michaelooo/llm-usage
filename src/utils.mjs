import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// 代理 dispatcher：让外网 provider（codex/claude）走 HTTPS_PROXY。
// undici 未装或无代理 env 时降级直连，不影响内网 provider。
let proxyDispatcher;
try {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy) {
    const { ProxyAgent } = await import('undici');
    proxyDispatcher = new ProxyAgent(proxy);
  }
} catch {}
export { proxyDispatcher };

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const UNDERLINE = '\x1b[4m';

export const COLORS = {
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};

// 响应体里若回显了凭证，脱敏后只取截断片段，避免 key/cookie 打到终端
export function redactSecrets(value, secrets = []) {
  let redacted = String(value);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    redacted = redacted.split(secret).join('***');
  }

  return redacted
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/acw_tc=[^;&\s"]+/g, 'acw_tc=***')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|cookie)["']?\s*[:=]\s*["']?)[^"',}\s]+/gi, '$1***');
}

export async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    const headerSecrets = Object.entries(options?.headers || {})
      .filter(([name]) => /authorization|cookie|api[-_]key/i.test(name))
      .flatMap(([, headerValue]) => {
        const value = String(headerValue);
        return [value, value.replace(/^Bearer\s+/i, '')];
      });
    const redactedText = redactSecrets(text, headerSecrets);
    const snippet = redactedText.slice(0, 200) + (redactedText.length > 200 ? ' …' : '');
    throw new Error(`HTTP ${res.status}: ${snippet}`);
  }
  return res.json();
}

// 业务码错误：HTTP 200 但响应体 code !== 0
export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

export async function postJson(url, body, { headers = {}, timeoutMs = 10000, dispatcher } = {}) {
  // body 里带 apiKey，出错时必须按 secret 脱敏
  const bodySecrets = Object.values(body || {}).filter(v => typeof v === 'string' && v.length > 0);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher,
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? `请求超时（${timeoutMs}ms）` : error?.message;
    throw new Error(redactSecrets(reason, bodySecrets));
  }

  const text = await res.text();
  const redacted = redactSecrets(text, bodySecrets);
  if (!res.ok) {
    const snippet = redacted.slice(0, 200) + (redacted.length > 200 ? ' …' : '');
    throw new Error(`HTTP ${res.status}: ${snippet}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应不是合法 JSON: ${redacted.slice(0, 120)}`);
  }
}

export const BUSINESS_RETRY_DELAYS_MS = [200, 600, 1800];

// 文档要求以响应体的 code 为准，不能只看 HTTP 状态码。
// 仅对 retryCodes（默认 50000 服务端异常）和网络错误退避重试，其余业务码直接抛。
export async function postBusinessJson(url, body, {
  retryCodes = [50000],
  delays = BUSINESS_RETRY_DELAYS_MS,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ...options
} = {}) {
  let lastError;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]);

    let payload;
    try {
      payload = await postJson(url, body, options);
    } catch (error) {
      lastError = error;
      continue;
    }

    if (payload?.code === 0) return payload.data ?? {};

    lastError = new ApiError(payload?.code, payload?.message || '未知业务错误');
    if (!retryCodes.includes(payload?.code)) throw lastError;
  }

  throw lastError;
}

export function fmtUsd(n) {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtNumber(n) {
  return Number(n).toLocaleString('en-US');
}

export function fmtCompactNumber(n) {
  const value = Number(n) || 0;
  const units = [
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000, suffix: 'K' },
  ];
  const unit = units.find(({ threshold }) => Math.abs(value) >= threshold);
  if (!unit) return fmtNumber(value);

  return `${(value / unit.threshold).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}${unit.suffix}`;
}

export function fmtValue(n, unit) {
  return unit === 'USD' ? fmtUsd(n) : `${fmtNumber(n)}${unit}`;
}

// OSC 8 超链接：\x1b]8;;URL\x07 文本 \x1b]8;;\x07，两端序列都不占可见宽度
// biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配 OSC 序列必须用 \x1b 控制字符
export const OSC8_PATTERN = /\x1b\]8;;[^\x07]*\x07/g;
export const OSC8_CLOSE = '\x1b]8;;\x07';

export function stripAnsi(str) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 剥离 ANSI 颜色码必须用 \x1b 控制字符
  return String(str).replace(/\x1b\[[0-9;]*m/g, '').replace(OSC8_PATTERN, '');
}

const graphemeSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;
const emojiPattern = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;
const zeroWidthPattern = /^[\p{Mark}\p{Format}]+$/u;
const wideCharacterPattern = /[\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3040-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u;

function graphemes(str) {
  const value = stripAnsi(str);
  return graphemeSegmenter
    ? [...graphemeSegmenter.segment(value)].map(({ segment }) => segment)
    : [...value];
}

function graphemeWidth(grapheme) {
  if (zeroWidthPattern.test(grapheme)) return 0;
  if (emojiPattern.test(grapheme) || wideCharacterPattern.test(grapheme)) return 2;
  return 1;
}

export function visualWidth(str) {
  return graphemes(str).reduce((width, grapheme) => width + graphemeWidth(grapheme), 0);
}

export function visualTruncate(str, maxWidth) {
  if (maxWidth <= 0) return '';

  let output = '';
  let width = 0;
  for (const grapheme of graphemes(str)) {
    const nextWidth = graphemeWidth(grapheme);
    if (width + nextWidth > maxWidth) break;
    output += grapheme;
    width += nextWidth;
  }
  return output;
}

// visualTruncate 会剥掉 ANSI，看板需要按可见宽度裁剪但保留颜色
export function visualTruncateAnsi(str, maxWidth) {
  const value = String(str);
  if (maxWidth <= 0) return '';
  if (visualWidth(value) <= maxWidth) return value;

  // biome-ignore lint/suspicious/noControlCharactersInRegex: 切分 ANSI 序列必须用 \x1b 控制字符
  const tokens = value.split(/(\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07)/);
  let output = '';
  let width = 0;
  let sawAnsi = false;
  let linkOpen = false;

  // 截断可能落在链接文本中间，必须补回闭合序列，否则终端会把后续输出继续当成链接
  const finish = () => `${output}${linkOpen ? OSC8_CLOSE : ''}${sawAnsi ? RESET : ''}`;

  for (const token of tokens) {
    if (token === '') continue;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 同上
    if (/^\x1b\[[0-9;]*m$/.test(token)) {
      output += token;
      sawAnsi = true;
      continue;
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 同上
    if (/^\x1b\]8;;[^\x07]*\x07$/.test(token)) {
      output += token;
      linkOpen = token !== OSC8_CLOSE;
      continue;
    }
    for (const grapheme of graphemes(token)) {
      const nextWidth = graphemeWidth(grapheme);
      if (width + nextWidth > maxWidth) return finish();
      output += grapheme;
      width += nextWidth;
    }
  }

  return finish();
}

export function visualPadEnd(str, width) {
  return str + ' '.repeat(Math.max(0, width - visualWidth(str)));
}

// 帧写入器假设「一行文本 = 终端一行」。错误信息里可能混入响应体的换行/制表，
// 直接渲染会让终端多占行、光标模型整体下移（看板每刷新一次就重复一行标题）。
// 保留 \x1b（ANSI 序列）和 \x07（OSC-8 结束符），只压平换行类控制符。
export function oneLine(str) {
  return String(str).replace(/[\t\n\v\f\r]+/g, ' ');
}

export function visualPadStart(str, width) {
  return ' '.repeat(Math.max(0, width - visualWidth(str))) + str;
}

export function formatReset(isoOrTs) {
  if (!isoOrTs) return '';
  try {
    const d = typeof isoOrTs === 'number' ? new Date(isoOrTs) : new Date(isoOrTs);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

export function formatCountdown(seconds) {
  if (!seconds || seconds <= 0) return '';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function readCodexToken(authPath = join(homedir(), '.codex/auth.json')) {
  const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
  return auth.tokens?.access_token;
}
