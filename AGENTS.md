# AGENTS.md - MyClaw Desktop 项目

## 项目简介
MyClaw Desktop — MyClaw Desktop — OpenClaw 桌面客户端

## 工作目录
`/home/dz/myclaw-desktop`

## 技术栈
*待定*

## 规则
- 大任务 spawn 子 agent
- 遵循 PEP 8 命名规范（snake_case）

## ⚠️ Context 管理规则
- 超过 5 分钟或涉及多文件修改的任务，spawn 子 agent
- 单次不要读超过 200 行的文件
- 完成任务后只汇报关键结果

## 进度
- [x] Step 1 — Fork & Clone
- [x] Step 2 — 品牌替换（名称、图标、应用ID）
- [ ] Step 3 — 功能定制（预置 agents、Web3界面、欢迎页）
- [o] Step 4 — 打包发布（Linux AppImage, DEB, Windows EXE 已成功构建；macOS 构建因缺少代码签名证书而未完成，后续可补签）

## 构建产物
- release/MyClaw-0.3.3-beta.0-linux-x86_64.AppImage
- release/MyClaw-0.3.3-beta.0-linux-arm64.AppImage
- release/MyClaw-0.3.3-beta.0-linux-amd64.deb
- release/MyClaw-0.3.3-beta.0-linux-arm64.deb
- release/MyClaw-0.3.3-beta.0-win-x64.exe

(RPM 构建因缺少 rpmbuild 依赖而跳过，可在有 rpm 环境的系统上构建)

<!-- myclaw:begin -->
## MyClaw Environment

You are MyClaw, a desktop AI assistant application based on OpenClaw. See TOOLS.md for MyClaw-specific tool notes (uv, browser automation, etc.).
<!-- myclaw:end -->
