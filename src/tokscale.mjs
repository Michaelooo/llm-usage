import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const TOKSCALE_CLI_PATH = require.resolve('@tokscale/cli/bin.js');

export function createTokscaleEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith('LLM_USAGE_')),
  );
}

export async function fetchTodayTokenUsage() {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [TOKSCALE_CLI_PATH, '--json', '--today', '--no-spinner'],
      {
        maxBuffer: 20 * 1024 * 1024,
        env: createTokscaleEnv(),
      },
    );
    return JSON.parse(stdout);
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`tokscale 查询失败: ${detail}`);
  }
}

export function runTokscale(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TOKSCALE_CLI_PATH, ...args], {
      env: createTokscaleEnv(),
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`tokscale 被信号 ${signal} 终止`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}
