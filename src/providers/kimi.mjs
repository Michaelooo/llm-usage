import { fetchJson } from '../utils.mjs';

function windowLabel(window) {
  const duration = Number(window.duration ?? 0);
  const unit = window.timeUnit ?? '';
  if (unit === 'TIME_UNIT_MINUTE' && duration > 0) {
    if (duration % 60 === 0) return `${duration / 60}小时`;
    return `${duration}分钟`;
  }
  if (unit === 'TIME_UNIT_HOUR' && duration > 0) return `${duration}小时`;
  if (unit === 'TIME_UNIT_DAY' && duration > 0) return `${duration}天`;
  if (unit === 'TIME_UNIT_SECOND' && duration > 0) return `${duration}秒`;
  return '窗口';
}

export default {
  name: 'Kimi Coding',
  color: '\x1b[35m',

  async fetch(config) {
    const url = 'https://api.kimi.com/coding/v1/usages';
    const apiKey = config.api_key;
    if (!apiKey) {
      throw new Error('缺少配置：LLM_USAGE_KIMI_API_KEY 或 providers.kimi.api_key');
    }

    const data = await fetchJson(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const usage = data.usage || {};
    const limitItem = (data.limits || [])[0] || {};
    const windowMeta = limitItem.window || {};
    const window = limitItem.detail || {};

    const mainLimit = Number(usage.limit ?? 0);
    const mainUsed = Number(usage.used ?? 0);
    const mainRemaining = Number(usage.remaining ?? 0);
    const mainPercent = mainLimit > 0 ? (mainUsed / mainLimit) * 100 : 0;

    const winLimit = Number(window.limit ?? 0);
    const winUsed = Number(window.used ?? 0);
    const winRemaining = Number(window.remaining ?? 0);
    const winPercent = winLimit > 0 ? (winUsed / winLimit) * 100 : 0;

    return {
      lines: [
        { label: '周限额', used: mainUsed, limit: mainLimit, unit: '次', percent: mainPercent, remaining: mainRemaining, resetTime: usage.resetTime },
        { label: `${windowLabel(windowMeta)}限额`, used: winUsed, limit: winLimit, unit: '次', percent: winPercent, remaining: winRemaining, resetTime: window.resetTime },
      ],
    };
  },
};
