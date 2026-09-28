# 发布机制与踩坑记录

本文记录 npm 发布自动化的工作方式和 2026-09 配置过程中遇到的实际问题，供日后维护参考。

## 当前机制

采用 npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)（OIDC）：

1. 推送 `v*` tag 触发 `.github/workflows/publish.yml`。
2. CI 校验 tag 与 `package.json` 版本一致 → lint → test → `npm publish`（OIDC 认证，自动生成 provenance）→ 创建 GitHub Release。
3. 全程不需要任何 npm token 或 secret。

日常发版：

```bash
npm version patch   # 或 minor / major
git push --follow-tags
```

信任关系由 `npm trust github @michaelooo/llm-usage --file publish.yml --repo Michaelooo/llm-usage --allow-publish -y` 注册（需包已存在、本机 npm >= 11.5.1、浏览器完成 2FA 交互）。

## 背景约束（npm 2026 安全策略）

- 发布动作必须经过 2FA 验证：交互式发布、bypass-2FA token、或 Trusted Publishing 三选一。未开启 2FA 的账号发布同样被拒。
- 带 bypass-2FA 的 Granular Access Token 正在被弃用（官方公告：2027-01 起不能发布），不要再用 token 方案配 CI。
- 官方指定的自动化路径只有 Trusted Publishing。

## 踩过的坑

| # | 现象 | 原因 | 处理 |
|---|------|------|------|
| 1 | CI 发布 403 `Two-factor authentication or granular access token with bypass 2fa enabled is required` | granular token 权限选了 stage only；之后即使勾了 bypass 2FA，也撞上 token 弃用政策 | 放弃 token，改 Trusted Publishing |
| 2 | 未开启 2FA 时本地 `npm publish` 也 403 | 同一条账号级强制策略 | 无法绕开，2FA 是必选项 |
| 3 | `npm trust github` 对未发布的包报 404 `Package not found` | 信任注册的前提是包已存在 | 首版必须用本人身份手动发布（`npm publish --access public`，npm 12 + passkey 可直接过浏览器验证） |
| 4 | `npm publish` 警告 `bin ... was invalid and removed/cleaned` | npm 12 不接受 bin 值带 `./` 前缀 | `npm pkg fix` 规范为 `bin/llm-usage.mjs` |
| 5 | 发布成功但 `npm view` 404 | 新包 registry 元数据传播慢（官网/ACL 可见，packument 延迟几分钟） | 等待即可，以官网或 `npm access list packages` 为准 |
| 6 | 命令在 Claude 会话里跑报 EOTP/不弹浏览器 | npm 的浏览器 2FA 交互需要真实 TTY | 涉及浏览器确认的命令在自己的终端里跑 |

## 故障排查

- CI 发布失败：看 GitHub Actions 该次 run 的「发布到 npm」步骤日志；403/404 类错误对照上表。
- 验证发布是否真成功（不依赖 Actions 页面）：`npm view @michaelooo/llm-usage version`，或直接访问 `https://www.npmjs.com/package/@michaelooo/llm-usage`。
- 版本已存在导致 EPUBLISHEXISTS：不要 re-run 旧 run，发下一个版本即可。
