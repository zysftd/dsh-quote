# dsh-quote

DSH（DeepSeek Harness）web 插件：把聊天里的 AI 生成内容**引用**到你的下一条指令里。

GitHub 式"引用回复"体验，但更进一步——引用不是以裸文本堆进输入框，而是以**原生风格的 UI 卡片**嵌在输入框内部，发送时才以 `> 引用块` 附带进消息，模型能明确看到带来源的引用。

## 功能

| 入口 | 触发方式 | 结果 |
|---|---|---|
| **划选引用** | 选中聊天里任意文字 → 选中处上方浮出「引用」按钮 | 引用卡片 |
| **整条引用** | 每条已完成 AI 回复的操作行新增「引用」按钮 | 引用卡片（来源标注"引用 AI 回复"） |
| **大文本粘贴** | 在输入框粘贴 **>300 字**的文本 | 引用卡片（来源标注"粘贴"），不再把大文本倒进输入框 |

三种入口都汇聚到同一个机制：**输入框内部顶部出现一条原生风格的引用卡片**（标签 + 引用内容预览 + × 移除），输入框保持干净，你正常打字；**发送时**引用块自动注入到消息开头（引用在前、你的话在后），回车或点发送按钮均可。

## 工作机制

### 引用卡片：真正的占位行，不叠字
DSH 的输入框很特殊：textarea 文字是透明的（`color: #0000`），**可见文字渲染在独立的镜像/backdrop 层**上。所以给 textarea 加 padding 没用——正确做法是给**滚动容器**（textarea 最近的 `overflow-y: auto/scroll` 祖先）加 `padding-top`，把整个输入内容（含可见文字层）真实推下，空出顶部一条占位行；引用卡片 fixed 定位落在这条空行里。400ms 守护循环 + 精确锁定 composer textarea（值匹配草稿 / 面积最大兜底），保证卡片永远不压文字、不碰上方官方 dock 组件（todo/goal/queue）。

### 发送注入：双通道
- **发送按钮**：包装 `inputActions.submit`（`Object.defineProperty`，失败静默降级），提交前把 `> 引用块` 注入草稿。
- **回车发送**：DSH 的回车路径直调输入机（`keyboard.submit`），绕过 `inputActions.submit`——因此额外用 **capture 阶段 keydown 监听**拦截：仅在卡片待发且焦点在输入框时生效，注入引用后调用 `inputActions.submit()`（与按钮完全相同的提交路径）。守卫齐全：IME 组合输入、修饰键、连发、斜杠命令模式（草稿以 `/` 开头）、焦点不在输入框，全部放行不干扰。

### 配色
100% 使用 DSH 主题 token（`--dsw-alias-bg-layer-1` / `border-l2` / `label-primary` / `label-secondary` / `bg-layer-2`），无任何硬编码颜色，浅色/深色主题自动跟随。

### 无 host 逻辑、无网络、无持久化
纯 client 插件：不请求任何网络、不读写文件、不触碰会话存储，只通过平台输入 store（`InputActions.setDraft`）写入草稿。

## 安装

```bash
# 本仓库以 link 形式挂进 web profile
dsh plugin --profile web add -w link:/home/arch-xnn/项目/dsh plub/dsh-quote
```

或手动：web profile `package.json` 的 `dependencies` 加 `"dsh-quote": "link:/home/arch-xnn/项目/dsh plub/dsh-quote"`、`dsh.profile.bundles` 加 `"dsh-quote"`，然后 `pnpm install`。

bundle 层的 `cordis.patch.yml` 会自动插入插件行，无需手改 profile 的 `cordis.patch.yml`。安装/更新后需重启 `dsh web` 并在浏览器**硬刷新**（client bundle 内容变更，rev 哈希随之变化）。

卸载：
```bash
dsh plugin --profile web remove dsh-quote
```

## 开发

### 结构

```
dsh-quote/
├── lib/
│   ├── index.js      # host 半（空实现，占位）
│   └── client.js     # client 半（全部功能，无构建）
├── cordis.patch.yml  # bundle 挂载补丁（- id: dsh-quote）
├── package.json
└── README.md
```

### 关键技术点（踩坑记录）

1. **Client bundle 必须用 `__ModuleLoader__.load` 注册**：浏览器端加载器要求 factory 形态 CJS——
   `window.__ModuleLoader__.load({ id: 'dsh-quote', factory: (require) => { ...; return { apply } } })`，
   `react` 通过加载器的 `require` 从 seed 表解析。写成普通 ESM 会报
   `bundle loaded without registering "dsh-quote" via __ModuleLoader__.load`。
2. **`useSession` / `useInput` 等 SnapshotSelectorHook 的 selector 是必填参数**：`useSession()` 不传会崩
   （`TypeError: w is not a function`）。必须 `useSession((s) => s)`。
3. **回车发送绕过 `inputActions.submit`**：Enter 走输入机内部 `keyboard.submit`，只包 submit 覆盖不了回车。
4. **可见文字不在 textarea 上**：在 mirror/backdrop 层，占位必须加在滚动容器上。
5. **输入快照要新鲜**：`shared.input` 需在渲染期同步（effect 依赖不含快照时不会随输入更新），否则发送时拼接的是旧草稿，用户文字会丢。

### 调试

- 改动 `lib/client.js` 后 `node --check lib/client.js` 验语法，浏览器硬刷新即可（纯 client 改动无需重启 GUI，除非改了 bundle 行）。
- 控制台报错看 `dsh-quote` 前缀或红色错误；常见问题对照上面的踩坑记录。

## 限制

- 划选引用需页面文本可选；`user-select: none` 的内容选不中。
- 大文本粘贴阈值固定 300 字（`PASTE_QUOTE_THRESHOLD`，可改）。
- 斜杠命令模式（草稿以 `/` 开头）下回车不拦截，引用不会注入（避免破坏命令菜单）。
- 引用块为纯文本 markdown，模型侧按普通上下文读取。

## 许可

MIT
