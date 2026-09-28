import { fetchJson } from '../utils.mjs';

const UNIT_MAP = {
  1: '分钟',
  2: '小时',
  3: '小时',
  4: '天',
  5: '月',
};

function glmWindowLabel(unit, number) {
  const name = UNIT_MAP[unit] ?? `u${unit}`;
  return `${number}${name}`;
}

export default {
  name: 'GLM Coding Pro',
  color: '\x1b[34m',

  async fetch(config) {
    const url = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit';
    const apiKey = config.api_key;
    const cookie = config.cookie;
    if (!apiKey) {
      throw new Error('缺少配置：LLM_USAGE_GLM_API_KEY 或 providers.glm.api_key');
    }

    const headers = { Authorization: apiKey };
    if (cookie) headers.Cookie = cookie;

    const data = await fetchJson(url, { headers });
    const limits = data.data?.limits || [];
    const lines = [];

    for (const lim of limits) {
      const windowLabel = glmWindowLabel(lim.unit, lim.number);
      if (lim.type === 'TIME_LIMIT') {
        const used = Number(lim.currentValue ?? 0);
        const limit = Number(lim.usage ?? 0);
        const remaining = Number(lim.remaining ?? 0);
        const percent = Number(lim.percentage ?? (limit > 0 ? (used / limit) * 100 : 0));
        lines.push({
          label: '月度 MCP',
          used,
          limit,
          unit: '次',
          percent,
          remaining,
          resetTime: lim.nextResetTime,
        });
      } else if (lim.type === 'TOKENS_LIMIT') {
        const percent = Number(lim.percentage ?? 0);
        lines.push({
          label: `${windowLabel}Token`,
          percent,
          resetTime: lim.nextResetTime,
        });
      }
    }

    return {
      lines,
    };
  },
};
