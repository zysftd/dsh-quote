# dsh-quote

DSH web 插件：把聊天里的 AI 生成内容**引用**到输入框（GitHub 式"引用回复"）。

## 功能

1. **划选引用**：在页面里选中文字（通常是 AI 回复内容），选中处上方出现「引用」浮动按钮，点击后以 markdown 引用块（`> ...`）写入输入框，原有草稿保留在后面。
2. **整条引用**：每条已完成的 assistant 消息的操作行（IconActions）多一个「引用」按钮，一键把整条回复以引用块写入输入框。

写入走平台输入 store（`InputActions.setDraft`），不是直接改 DOM，React 状态一致；无 host 逻辑、无网络、无持久化。

## 安装

```bash
# 本仓库以 link 形式挂进 web profile
dsh plugin --profile web add -w link:/home/arch-xnn/项目/dsh plub/dsh-quote
# 或手动：web profile package.json 的 dependencies 加
#   "dsh-quote": "link:/home/arch-xnn/项目/dsh plub/dsh-quote"
# dsh.profile.bundles 加 "dsh-quote"，然后 pnpm install
```

bundle 层的 `cordis.patch.yml` 会自动插入插件行，无需手改 profile 的 cordis.patch.yml。改完需重启 `dsh web`。

## 结构

- `lib/index.js` — host 半（空实现，占位）
- `lib/client.js` — client 半（全部功能，纯 ESM + React，无构建）
- `cordis.patch.yml` — bundle 挂载补丁

## 限制

- 划选按钮渲染在 `conversation.input.overlay` 层，若宿主容器对 fixed 定位有裁剪，按钮会出现在输入框附近而非选中处（功能不受影响）。
- 引用块为纯文本 markdown，模型侧按普通上下文读取。
