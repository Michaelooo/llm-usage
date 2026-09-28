import { fetchJson, readCodexToken, proxyDispatcher } from '../utils.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

export function formatWindowLabel(window) {
  const seconds = Number(window?.limit_window_seconds ?? 0);
  if (seconds === FIVE_HOURS_SECONDS) return '5小时';
  if (seconds === SEVEN_DAYS_SECONDS) return '周限额';
  if (seconds >= 86400 && seconds % 86400 === 0) return `${seconds / 86400}天`;
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}小时`;
  return '限额';
}

function buildWindowLine(window) {
  if (!window || typeof window !== 'object') return null;
  return {
    label: formatWindowLabel(window),
    percent: Number(window.used_percent ?? 0),
    resetAfter: Number(window.reset_after_seconds ?? 0),
  };
}

export default {
  name: 'Codex',
  color: '\x1b[33m',

  async fetch(config) {
    const authPath = config.auth_path || join(homedir(), '.codex/auth.json');
    const token = config.access_token || readCodexToken(authPath);
    if (!token) {
      throw new Error(`缺少 Codex access token：请设置 LLM_USAGE_CODEX_ACCESS_TOKEN，或检查 ${authPath}`);
    }

    const url = 'https://chatgpt.com/backend-api/wham/usage';
    const data = await fetchJson(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'codex-cli',
      },
      dispatcher: proxyDispatcher,
    });

    const resetCredits = data.rate_limit_reset_credits?.available_count ?? 0;
    const lines = [
      buildWindowLine(data.rate_limit?.primary_window),
      buildWindowLine(data.rate_limit?.secondary_window),
    ].filter(Boolean);

    if (lines.length === 0) {
      throw new Error('Codex usage API 未返回可识别的额度窗口');
    }

    return { meta: `重置券 ${resetCredits}`, lines };
  },
};
