import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const emptyTokenReport = {
  entries: [],
  totalInput: 0,
  totalOutput: 0,
  totalCacheRead: 0,
  totalCacheWrite: 0,
  totalMessages: 0,
  totalCost: 0,
};

function mockExecFile(_file, _args, _options, callback) {
  callback(null, JSON.stringify(emptyTokenReport), '');
}

mockExecFile[promisify.custom] = async () => ({
  stdout: JSON.stringify(emptyTokenReport),
  stderr: '',
});
childProcess.execFile = mockExecFile;
syncBuiltinESMExports();

// 多账号场景：每个 Key 有独立的额度，用来验证实例之间不串号。
const KIMI_BY_KEY = {
  'kimi-key-a': { limit: 100, used: 10, winLimit: 50, winUsed: 5 },
  'kimi-key-b': { limit: 200, used: 80, winLimit: 50, winUsed: 40 },
  'kimi-env-secret': { limit: 100, used: 10, winLimit: 50, winUsed: 5 },
};

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify(payload); },
    async json() { return payload; },
  };
}

globalThis.fetch = async (url, options) => {
  const target = String(url);

  if (target === 'https://api.kimi.com/coding/v1/usages') {
    const apiKey = String(options?.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
    const account = KIMI_BY_KEY[apiKey];
    if (!account) throw new Error('测试未模拟该 Kimi Key');
    return jsonResponse({
      usage: {
        limit: account.limit,
        used: account.used,
        remaining: account.limit - account.used,
      },
      limits: [{
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: {
          limit: account.winLimit,
          used: account.winUsed,
          remaining: account.winLimit - account.winUsed,
        },
      }],
    });
  }

  throw new Error(`测试未模拟请求: ${url}`);
};
