import kimi from './kimi.mjs';
import glm from './glm.mjs';
import codex from './codex.mjs';
import claude from './claude.mjs';
import { resolveProviderType } from '../config.mjs';

export const PROVIDERS = {
  kimi,
  glm,
  codex,
  claude,
};

// 一个 provider 实现可以有多个账号实例，label 用来在看板上区分它们
export function getEnabledProviders(config, filterNames) {
  const configured = config?.providers || {};
  const names = filterNames?.length
    ? filterNames.filter(n => configured[n])
    : Object.keys(configured);

  return names
    .map(name => {
      const providerConfig = configured[name] || {};
      const type = resolveProviderType(name, providerConfig);
      const provider = PROVIDERS[type];
      return {
        name,
        type,
        provider,
        label: providerConfig.label || provider?.name || name,
        config: providerConfig,
      };
    })
    .filter(({ provider, config: c }) => provider && c.enabled);
}

export function listProviderNames() {
  return Object.keys(PROVIDERS);
}
