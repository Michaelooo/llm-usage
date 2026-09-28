# Provider 配置说明

本项目内置四个 provider：Kimi Coding、GLM Coding Pro、Codex 和 Claude Code。
这些 provider 读取的是各家客户端使用的用量接口，接口可能变化或失效，使用前请自行确认服务商的规则。

## 通用配置项

每个 provider 都支持：

| 字段 | 说明 |
| --- | --- |
| `enabled` | 是否启用，`true` 或 `false` |
| `label` | 看板上的显示名；不填则使用 provider 默认名称 |

顶层 `watch` 控制刷新节奏：

| 字段 | 默认值 | 最小值 | 说明 |
| --- | ---: | ---: | --- |
| `quota_interval_sec` | 60 | 10 | 额度 HTTP 请求的刷新间隔 |
| `token_interval_sec` | 900 | 60 | 本地 Token 统计的刷新间隔 |

## Kimi Coding

```yaml
providers:
  kimi:
    enabled: true
    api_key: "你的 API Key"
```

| 字段 | 必填 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `api_key` | 是 | `LLM_USAGE_KIMI_API_KEY` | Kimi Coding API Key |

## GLM Coding Pro

```yaml
providers:
  glm:
    enabled: true
    api_key: "你的 API Key"
    cookie: "可选 cookie"
```

| 字段 | 必填 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `api_key` | 是 | `LLM_USAGE_GLM_API_KEY` | Authorization 头里的字符串 |
| `cookie` | 否 | `LLM_USAGE_GLM_COOKIE` | 部分账号需要的 cookie，没有可留空 |

## Codex（ChatGPT Plus）

```yaml
providers:
  codex:
    enabled: true
    access_token: ""
    auth_path: "~/.codex/auth.json"
```

| 字段 | 必填 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `access_token` | 否 | `LLM_USAGE_CODEX_ACCESS_TOKEN` | 留空则从本地 auth 文件读取 |
| `auth_path` | 否 | `LLM_USAGE_CODEX_AUTH_PATH` | 默认 `~/.codex/auth.json` |

## Claude Code（Claude Pro/Max）

```yaml
providers:
  claude:
    enabled: true
    access_token: ""
```

| 字段 | 必填 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `access_token` | 否 | `LLM_USAGE_CLAUDE_ACCESS_TOKEN` | 留空则读取本机 Claude Code 凭证 |

## 同一实现配置多个账号

内置 provider 的键名就是实现名。额外账号使用任意合法键名，并用 `type` 指向实现名：

```yaml
providers:
  kimi:
    enabled: true
    api_key: "工作号 Key"
    label: "Kimi 工作号"
  kimi-2:
    type: kimi
    enabled: true
    api_key: "个人号 Key"
    label: "Kimi 个人号"
```

环境变量只作用于内置实例，不会覆盖 `kimi-2` 的配置。

## 添加新的 Provider

如果服务商的用量接口不是内置 provider，可以按下面的约定添加一个实现。当前项目是纯 ESM，文件放在 `src/providers/` 下，默认导出一个对象。

1. 在 `src/providers/` 下新建文件，例如 `myprovider.mjs`
2. 默认导出对象，包含 `name`、`color`、异步 `fetch(config)`
3. 在 `src/providers/index.mjs` 中注册
4. 在 `src/config.mjs` 的 `DEFAULT_PROVIDERS` 和 `ENV_CONFIG` 中补默认值与环境变量名
5. 在 `src/web/schema.mjs` 的 `PROVIDER_FIELDS` 中补字段说明（中文名、类型、帮助文本），网页面板才会渲染它。默认值和环境变量名不要在这里重复定义，schema 会从 `config.mjs` 取

最小实现：

```js
export default {
  name: 'My Provider',
  color: '\x1b[32m',

  async fetch(config) {
    return {
      meta: 'plan pro',
      lines: [
        { label: '日限额', used: 10, limit: 100, unit: '次', percent: 10, remaining: 90 },
      ],
    };
  },
};
```

`fetch(config)` 返回 `{ meta, lines }`：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `meta` | 否 | 跟在 provider 名后面的一小段说明，比如套餐名 |
| `lines[].label` | 是 | 这一行额度的名字，比如「周限额」 |
| `lines[].percent` | 是 | 已用百分比，0-100；它是渲染进度条的必要字段 |
| `lines[].used` / `limit` | 否 | 有具体数字就填，会渲染成 `10 / 100` |
| `lines[].unit` | 否 | `used`/`limit` 的单位，比如 `次`、`USD` |
| `lines[].remaining` | 否 | 剩余量，渲染在行尾括号里 |
| `lines[].resetTime` | 否 | 额度重置时间，支持 ISO 字符串或毫秒时间戳 |
| `lines[].resetAfter` | 否 | 距离重置的秒数 |

只填 `label` + `percent` 就能工作，其余字段是补充展示信息。

`fetch` 里直接 `throw` 即可，看板会把这个 provider 标红并显示错误消息，其他 provider 不受影响。错误消息会经过脱敏，配置中的 Key 会被替换成 `***`。

缺少必填配置时，错误消息里请带上对应的环境变量名和配置路径，例如：

```text
缺少配置：LLM_USAGE_KIMI_API_KEY 或 providers.kimi.api_key
```

这样用户能直接知道应该设置哪个字段，也方便网页面板的「测试连接」显示可操作的提示。
