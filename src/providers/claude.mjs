import { fetchJson, proxyDispatcher } from '../utils.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS_FILE = join(homedir(), '.claude/.credentials.json');
const HUD_CACHE = join(homedir(), '.claude/plugins/claude-hud/.usage-cache.json');

// 读 OAuth accessToken：优先 macOS Keychain（新版 CC 存这里），兜底老版本 .credentials.json
function readAccessToken() {
  try {
    const raw = execSync(`/usr/bin/security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    if (token) return token;
  } catch {}
  try {
    const creds = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
    return creds?.claudeAiOauth?.accessToken || null;
  } catch {}
  return null;
}

function readHudCache() {
  try {
    return JSON.parse(readFileSync(HUD_CACHE, 'utf8'))?.data || null;
  } catch {
    return null;
  }
}

export default {
  name: 'Claude Code',
  color: '\x1b[35m',

  async fetch(config) {
    const token = config.access_token || readAccessToken();
    let fiveHour = null, sevenDay = null;
    let fiveHourReset = null, sevenDayReset = null;
    let planName = '';

    // 路径 B：直接调 OAuth usage API
    if (token) {
      try {
        const data = await fetchJson(USAGE_URL, {
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'claude-code/2.1',
          },
          dispatcher: proxyDispatcher,
        });
        fiveHour = data.five_hour?.utilization ?? null;
        sevenDay = data.seven_day?.utilization ?? null;
        fiveHourReset = data.five_hour?.resets_at ?? null;
        sevenDayReset = data.seven_day?.resets_at ?? null;
      } catch {
        // API 失败（401/网络）→ 走 claude-hud 缓存兜底
      }
    }

    // 路径 A：读 claude-hud 缓存兜底
    if (fiveHour === null && sevenDay === null) {
      const cache = readHudCache();
      if (cache) {
        planName = cache.planName || '';
        fiveHour = cache.fiveHour ?? null;
        sevenDay = cache.sevenDay ?? null;
        fiveHourReset = cache.fiveHourResetAt ?? null;
        sevenDayReset = cache.sevenDayResetAt ?? null;
      }
    }

    if (fiveHour === null && sevenDay === null) {
      throw new Error('无法获取用量：请设置 LLM_USAGE_CLAUDE_ACCESS_TOKEN，或登录 Claude Code/配置 claude-hud');
    }

    const toPercent = v => (v == null ? null : Math.round(Math.max(0, Math.min(100, v))));
    const lines = [];
    if (toPercent(fiveHour) !== null) {
      lines.push({ label: '5小时', percent: toPercent(fiveHour), resetTime: fiveHourReset });
    }
    if (toPercent(sevenDay) !== null) {
      lines.push({ label: '周限额', percent: toPercent(sevenDay), resetTime: sevenDayReset });
    }

    return { meta: planName, lines };
  },
};
