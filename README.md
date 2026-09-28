# llm-usage

终端里的 LLM 额度与本地 Token 用量看板：一次查看多个服务的额度、刷新倒计时和今天的本地 Token 消耗。

> **关于数据来源**：本工具读取的是各家产品面向自身客户端的用量接口，这些接口未被官方文档化，随时可能变更或失效。GLM 还需要你自行提供 cookie。请自行判断是否符合你与各服务商的约定，使用风险自负。

## 特性

- 支持 Kimi Coding、GLM Coding Pro、Codex、Claude Code
- 终端看板显示额度进度、剩余量、重置时间和刷新变化量
- `watch` 模式原地刷新，配置文件修改后自动热重载
- 统计本机今天的 Token 使用量和估算费用
- 同一个 provider 支持配置多个账号实例
- 提供终端交互配置和本地网页配置面板
- API Key 和 Token 默认脱敏，配置文件权限为 `600`

## 安装

### 公共 npm 安装

```bash
npm install -g @michaelcheng/llm-usage
# 或
pnpm add -g @michaelcheng/llm-usage
```

不想全局安装，也可以直接运行：

```bash
npx @michaelcheng/llm-usage
```

### 本地克隆安装

```bash
git clone <仓库地址>
cd llm-usage
pnpm install
pnpm start
```

要求 Node.js >= 18。

## 配置

默认配置文件：`~/.config/llm-usage/config.yaml`。

第一次运行时，如果当前终端支持交互，会自动进入配置向导。也可以手动运行：

```bash
llm-usage --setup
```

配置示例：

```yaml
providers:
  kimi:
    enabled: true
    api_key: "你的 Kimi Coding API Key"
  glm:
    enabled: false
    api_key: "你的 GLM Coding Pro API Key"
    cookie: "可选 cookie"
  codex:
    enabled: true
    # 留空则读取 ~/.codex/auth.json
    access_token: ""
    auth_path: "~/.codex/auth.json"
  claude:
    enabled: true
    # 留空则读取 Claude Code 的本地凭证
    access_token: ""
watch:
  quota_interval_sec: 60
  token_interval_sec: 900
```

每个 provider 的字段、环境变量和接口说明见 [`docs/providers.md`](docs/providers.md)。

### 网页配置面板

一行命令启动本地配置面板：

```bash
llm-usage web
```

只打印地址、不自动打开浏览器：

```bash
llm-usage web --no-open
```

面板只监听回环地址，URL 中的令牌仅对本次运行有效。保存配置后，正在运行的 `watch` 会自动加载新配置。

### 配置热重载

`watch` 运行期间编辑 `~/.config/llm-usage/config.yaml`，约两秒内会加载新 provider、账号和刷新间隔，不需要重启：

```bash
llm-usage --watch
```

配置文件中残留了当前版本不认识的 provider 时，程序会跳过它并在 stderr 提示，不会阻塞其他 provider。升级或迁移配置时可以直接继续使用。

### 同一个 Provider 配置多个账号

配置实例名可以自定义，额外实例用 `type` 指向已有实现：

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

`label` 用来在看板上区分账号。环境变量只覆盖内置实例，不会覆盖额外账号，避免多个账号串号。

## 用法

```bash
# 查看所有启用 provider 的额度和今天的 Token 消耗
llm-usage

# 只查询指定 provider 或账号实例
llm-usage --provider kimi
llm-usage --provider kimi,kimi-2

# 定时刷新模式（Ctrl-C 退出）
llm-usage --watch

# 自定义刷新间隔：额度 30 秒、Token 15 分钟
llm-usage --watch --interval 30 --token-interval 900

# JSON 输出
llm-usage --json

# 查看配置文件路径
llm-usage --config

# 列出内置 provider
llm-usage --list-providers

# 只查看今天的 Token 消耗
llm-usage token

# Token 子命令的其余参数会原样交给 Tokscale
llm-usage token --help

# 查看帮助
llm-usage --help
```

额度请求失败时，其他 provider 仍会继续显示；Token 统计失败时，额度看板也会照常渲染，并单独报告 Token 错误。

## 环境变量覆盖

环境变量优先级高于配置文件。凭证类变量存在时会自动启用对应 provider，显式设置 `*_ENABLED=false` 可以关闭自动启用。

```bash
export LLM_USAGE_KIMI_API_KEY="..."
export LLM_USAGE_GLM_API_KEY="..."
export LLM_USAGE_GLM_COOKIE="..."
export LLM_USAGE_CODEX_ACCESS_TOKEN="..."
export LLM_USAGE_CODEX_AUTH_PATH="~/.codex/auth.json"
export LLM_USAGE_CLAUDE_ACCESS_TOKEN="..."
export LLM_USAGE_WATCH_QUOTA_INTERVAL_SEC=60
export LLM_USAGE_WATCH_TOKEN_INTERVAL_SEC=900
```

## 开发

```bash
pnpm install
pnpm test
pnpm lint
pnpm pack
```

目录结构：

```text
bin/                  CLI 入口
src/providers/        provider 实现
src/web/              网页配置面板
src/                  配置、看板、watch 和 Token 统计
test/                  自动化测试
```

### Git 钩子

仓库内置两个零依赖 Git 钩子：

- `pre-commit`：提交前运行 lint
- `pre-push`：推送前运行全量测试

安装依赖时，`prepare` 脚本会自动设置 `core.hooksPath`。如果只执行了 `git clone` 还没有安装依赖，可以手动启用：

```bash
git config core.hooksPath .githooks
```

钩子默认不替代 CI；它只是尽早拦截本地明显错误。测试必须保持环境无关，避免某台机器能推送、另一台机器每次都被钩子拦住。

## License

[MIT](LICENSE)
