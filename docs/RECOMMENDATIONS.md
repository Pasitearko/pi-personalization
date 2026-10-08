# Skills、MCP 与配套插件推荐

这里是推荐清单，不会把作者机器上的 skill、登录信息或 MCP 配置一起导入。按需安装，不建议全装；各项目许可证与安全要求以原仓库为准。

## Skills

| Skill / 项目 | 用途 | 上游 |
|---|---|---|
| find-skills | 搜索可安装的 agent skills | [vercel-labs/skills](https://github.com/vercel-labs/skills) |
| grilling / grill-me | 对计划和决策进行追问、压力测试 | [mattpocock/skills](https://github.com/mattpocock/skills) |
| handoff | 整理工作交接 | [mattpocock/skills](https://github.com/mattpocock/skills) |
| teach | 教学式解释 | [mattpocock/skills](https://github.com/mattpocock/skills) |
| remotion-best-practices | Remotion 视频项目实践 | [remotion-dev/skills](https://github.com/remotion-dev/skills) |
| playwright-cli | 浏览器自动化和页面验证 | [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli) |
| Agent-Reach | 多平台互联网内容检索 | [Panniantong/Agent-Reach](https://github.com/Panniantong/Agent-Reach) |
| imagegen | 通过 Codex 登录使用图像生成；可能消耗额度 | [crazygit/pi-codex-image-gen](https://github.com/crazygit/pi-codex-image-gen) |

支持 skills CLI 的项目可用 `npx skills add <owner/repo>`，再选择所需 skill。CLI 默认可能安装到 `.agents/skills`；若你的 Pi 没有自动发现该目录，按 Pi skills 文档把所选 skill 放到 `~/.pi/agent/skills` 或在设置中明确添加路径。不要照搬别人的个人全局 AGENTS.md，也不要把其他 skill 的许可证改成 MIT。

## MCP

推荐从 **GitHub MCP** 开始：仓库检索、Issues、PR 和代码协作。上游：[github/github-mcp-server](https://github.com/github/github-mcp-server)。远程入口 `https://api.githubcopilot.com/mcp/`；每个人使用自己的 OAuth / PAT，权限遵循最小化原则。这个项目不提供任何账号凭据。

需要统一的搜索、按需连接和工具发现，可选 [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)：

```sh
pi install npm:pi-mcp-adapter
```

重启 Pi 后使用 `/mcp-adapter setup` 添加服务器，使用 `/mcp-auth github` 登录；也可让 Pi 调用 `mcp({ action: "install", url: "https://api.githubcopilot.com/mcp/" })`。Pi 自带 MCP 与适配器是否共用认证、工具名称等，以所安装版本的文档为准，避免重复注册同一服务器。

浏览器任务通常先用 Playwright skill，不必为每一个任务都新增 MCP。所有 MCP 写操作（发布、合并、删除等）应要求确认，OAuth tokens、cookies 和 MCP caches 只留本机。

## 其他 Pi 插件

- `alps-pi`：边框、底部编辑器和指标布局。本项目的高级补丁固定在 0.3.4。
- `@specode/pi-subscription-usage`：订阅额度数据源；本项目仅适配显示，不替代其查询逻辑。
- `billion-context`：上下文压缩、子代理等。余额/账户由它自身管理，本项目**不附带账户，也不伪造余额**。
- `pi-web-access`：网页检索与阅读。
- `@plannotator/pi-extension`：计划评审。
- `@narumitw/pi-btw`：旁支提问。
- `@crazygit/pi-codex-image-gen`：图像生成。

建议先装外观基础包，再按需求逐个添加这些可选项。它们更新时，先跑检查再决定是否重装本项目的高级补丁。
