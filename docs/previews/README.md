# 预览来源与隐私

这三张 PNG 是专门为开源仓库制作的演示预览，**不是桌面截屏，也不是作者私人会话截图**。

| 图片 | 来源 |
|---|---|
| overview.png | 真实 Pi 组件和 ALPS 边框输出；天气、额度、Fast、路径及指标行是明确标注的示例组合 |
| frame-click.png | 同一个真实 ToolExecutionComponent；调用本项目实际左键点击处理器后，比较折叠与展开状态 |
| clean-selection.png | 同一个真实 TuiAltScreen 选区；分别关闭和开启 clean-frame-copy，展示实际高亮结果及 getActiveSelectionText() 的复制文本 |

## 隐私处理

- 只使用自行编写的 TypeScript 示例和虚构对话，不读取历史会话、认证、余额或真实额度。
- 路径只有 `src/hello.ts` 和 `/workspace/demo` 等示例；不显示本机用户名、主目录、仓库工作目录或机器名。
- 时钟固定为演示时间；天气、额度、速度、花费等数字均不是真实账户数据。
- 生成器仅导入本仓库开发依赖；所有设置和主题在临时 agent 中隔离，网络请求被明确禁止。
- HTML 在空白独立浏览器中打开，只截图 `#capture` 内容，不包括地址栏、其他标签页、桌面或系统通知。不连接已登录浏览器、cookies 或持久化个人 profile。
- PNG 使用本机可用字体渲染为像素，不携带字体二进制。其他终端的字体、透明度、颜色和鼠标行为可能不同。

## 重建演示页面

```sh
npm ci --ignore-scripts
npm test
node tools/render-previews.mjs
```

生成器是 [tools/render-previews.mjs](../../tools/render-previews.mjs)，页面在本目录的三个 HTML 文件中。鼠标展开和干净选区都含断言，不会把手写的“效果示意”冒充真实处理器输出。

需要重新生成 PNG 时，在空白浏览器中打开对应 HTML，等待字体加载完成，以 1440px 视口截图 `#capture` 元素即可；截图后先检查全部文字和 PNG 元数据，再提交。不要使用私人会话或已登录的个人浏览器来补图。

页面和 PNG 按项目原创内容采用 MIT；这是演示材料，不是对所有终端显示效果的保证。
