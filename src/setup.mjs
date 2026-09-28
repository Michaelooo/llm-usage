import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import {
  CONFIG_PATH, CONFIG_DIR, DEFAULT_PROVIDERS, DEFAULT_WATCH, loadStoredConfig, toYaml,
} from './config.mjs';
import { PROVIDERS } from './providers/index.mjs';

const log = (...a) => console.log(...a);

export function mergeProviderConfig(existing, enabled) {
  return { ...existing, enabled };
}

// 额外账号实例（kimi-2 等）由用户手写维护，--setup 不管理但必须原样带过来，
// 否则这份整份重写会把它们连同 Key 一起抹掉
export function retainUnmanagedProviders(providers, existing) {
  for (const [key, value] of Object.entries(existing)) {
    if (providers[key]) continue;
    providers[key] = value;
  }
  return providers;
}

// 交互式配置 provider（合并式：保留已填的 Key，只对未填的提示输入）
export async function configureProviders() {
  // 动态加载：install.mjs 在依赖装好前就会 import 本模块，静态 import 会 ERR_MODULE_NOT_FOUND
  const { checkbox, password } = await import('@inquirer/prompts');
  // 环境变量只用于当前进程覆盖，不能在交互配置时落盘。
  const stored = loadStoredConfig();
  const existing = stored?.providers || {};
  // 整份文件是重写的，watch 节必须显式带过来，否则 --setup 会把刷新配置抹掉
  const watch = { ...DEFAULT_WATCH, ...(stored?.watch || {}) };
  const keys = Object.keys(DEFAULT_PROVIDERS);

  const selected = await checkbox({
    message: '选择要启用的 provider（空格选择，回车确认，已填 Key 会保留）：',
    choices: keys.map(key => ({
      name: PROVIDERS[key]?.name || key,
      value: key,
      checked: existing[key]?.enabled === true,
    })),
  });

  const providers = {};
  for (const key of keys) {
    const enabled = selected.includes(key);
    const old = existing[key] || {};

    if (!enabled) {
      // 未启用：保留旧字段（含 Key），仅置 enabled=false，便于将来重新启用
      providers[key] = mergeProviderConfig(old, false);
      continue;
    }

    const cfg = mergeProviderConfig(old, true);
    if (key === 'kimi') {
      cfg.api_key = old.api_key || await password({ message: '请输入 Kimi Coding API Key：', mask: '*' });
    } else if (key === 'glm') {
      cfg.api_key = old.api_key || await password({ message: '请输入 GLM Coding Pro API Key：', mask: '*' });
      cfg.cookie = old.cookie ?? '';
    } else if (key === 'codex') {
      cfg.auth_path = old.auth_path || join(homedir(), '.codex/auth.json');
      log('  Codex 将自动读取 ~/.codex/auth.json');
    } else if (key === 'claude') {
      log('  Claude 将自动读取 macOS Keychain / ~/.claude/.credentials.json');
    }
    providers[key] = cfg;
  }

  retainUnmanagedProviders(providers, existing);

  const yaml = `# LLM Usage 配置文件
# 本文件权限已设置为 600，请勿提交到 Git。

${toYaml({ providers, watch })}
`;

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, yaml, 'utf-8');
  try { chmodSync(CONFIG_PATH, 0o600); } catch {}
  log(`✓ 配置已写入: ${CONFIG_PATH}`);
}
