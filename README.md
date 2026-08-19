# dsh-quote

DSH（DeepSeek Harness）web 插件：把聊天里的内容引用到输入框。

## 功能

| 入口 | 触发方式 | 结果 |
|---|---|---|
| 划选引用 | 选中 **AI 回复正文**中的文字，点选中处上方的「引用」按钮 | 引用卡片 |
| 整条引用 | 已完成 AI 回复操作行的「引用」按钮 | 引用卡片 |
| 大文本粘贴 | 输入框粘贴超过 300 字的文本 | 引用卡片，大文本不直接进入输入框 |

引用卡片显示在输入框内部顶部（标签 + 内容预览 + × 移除），输入框保持干净。发送时引用块（`> ...`）自动加到消息开头，回车或点发送按钮均可。

## 安装

```bash
dsh plugin --profile web add -w link:/home/arch-xnn/项目/dsh-quote
```

bundle 层的 `cordis.patch.yml` 自动插入插件行，无需手改 profile 的 `cordis.patch.yml`。安装/更新后需重启 `dsh web`，浏览器硬刷新。

卸载：

```bash
dsh plugin --profile web remove dsh-quote
```

## 结构

```
dsh-quote/
├── lib/
│   ├── index.js      # host 半（空实现）
│   └── client.js     # client 半（全部功能，无构建）
├── cordis.patch.yml  # bundle 挂载补丁
├── package.json
└── README.md
```

## 实现要点

- Client bundle 通过 `window.__ModuleLoader__.load({ id, factory })` 注册（factory 形态 CJS）。
- 引用卡片嵌在输入框内部：给滚动容器（textarea 最近的有 `overflow-y` 的祖先）加 `padding-top` 空出占位行，卡片 fixed 定位落在上面。DSH 的可见文字渲染在镜像层而非 textarea 本身，所以不能只改 textarea 的 padding。
- 发送注入分两条路径：发送按钮包装 `inputActions.submit`；回车路径被绕过，用 capture 阶段 keydown 监听拦截，注入后调用 `inputActions.submit()`。
- 划选引用只认 AI 回复正文：选区两端必须落在 `data-chat-flow-kind="assistant-step"` 行内、且不在 `data-variant="think"` 思考折叠块内（该守卫有单元测试 `test/selection.test.mjs`）。
- 颜色用 DSH 主题 token（`--dsw-alias-*`），无硬编码颜色。
- 纯 client：无网络请求、无文件读写、无持久化，只通过 `InputActions.setDraft` 写草稿。

## 已知限制

- 划选引用只对 AI 回复正文生效：用户消息、工具调用卡片、思考过程（`data-variant="think"`）以及界面其它部分都不可划选引用。
- 页面 `user-select: none` 的内容选不中。
- 大文本粘贴阈值固定 300 字（`PASTE_QUOTE_THRESHOLD`）。
- 草稿以 `/` 开头（斜杠命令模式）时回车不拦截，引用不会注入。
- 引用块是纯文本 markdown。

## 许可

MIT
