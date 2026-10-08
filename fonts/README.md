# Optional letters-only italic font

字体是终端设置，不是 Pi 能自动替所有电脑安装的资源。本仓库**不分发字体二进制**；构建脚本 MIT，但官方字体及生成字体均遵守 SIL OFL 1.1。

1. 从 [subframe7536/Maple-font](https://github.com/subframe7536/Maple-font) 下载 Maple Mono **NF CN v8.0-beta.3** 的 Regular、Italic、Bold、BoldItalic 四个 TTF，及其 `LICENSE.txt`，放入一个独立目录。只验证此版本，不宣称后续版本轮廓/字宽都兼容。
2. 在本目录建立 Python 环境并安装依赖：`python -m pip install -r requirements.txt`。
3. `python build-fonts.py --source /path/to/upstream-fonts`（Windows 路径包含空格时加引号）。
4. 构建产物位于 `fonts/`。脚本验证字符覆盖、字宽、行指标及抽样轮廓；保留官方 LICENSE.txt。派生 family 是 **Studio Latin Italic NF CN**，不会覆盖官方 Maple family。
5. 使用系统字体安装方式：Windows 右键 TTF「为当前用户安装」、macOS Font Book、Linux `~/.local/share/fonts` 并运行 `fc-cache -f`。然后在终端里选择 family。

仅 A–Z/a–z 使用真斜体轮廓；数字、标点、汉字、框线和 Nerd Font 图标保持直立。四个派生样式沿用此规则。生成字体的 SHA-256 与验证结果存放在本目录的 build-report.json / font-metadata.json，默认不提交。

本项目没有执行你的系统字体安装操作，也不修改 Windows Terminal profile GUID、背景图路径或键绑定。示例见 [examples/windows-terminal.json](../examples/windows-terminal.json)。透明、亚克力及鼠标 Ctrl-click 行为由具体终端决定。
