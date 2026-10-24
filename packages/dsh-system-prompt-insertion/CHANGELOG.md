# dsh-system-prompt-insertion

## 0.2.0

### Minor Changes

- d2b7f30: 把预览移到段落编辑上方并常驻：进入页面、保存、切换全局启停时自动重新组装；标题旁新增刷新按钮，其他插件改动系统提示词后可手动重拉。移除底部预览按钮；保存 / 撤销移到段落区右下角，添加段落按钮移到列表末尾；全局启停改为切换即保存。
- e0c561f: 把插件与页面从「提示词段落」改名为「系统提示词注入」/「提示词注入」，包名与 loader id 统一为 `dsh-system-prompt-insertion` / `system-prompt-insertion`，状态文件迁移到 `$DSH_HOME/system-prompt-insertion.json`，注册名前缀改为 `user:system-prompt-insertion:`。
- e0c561f: 把编辑器从「设置」页挪到左侧栏面板：注册 `sidebar.panellist` 的一行（和 Plugins / 任务时间表同一排）与 `main` 槽里同 id 的面板，设置页不再出现。

  面板按宿主全局页面的版式重做成**单栏**：960px 内容列居中、两侧留白随窗口宽度自适应、标题 20px/500、macOS 下让开窗口顶部。段落卡片支持逐段启停、改名、位置、上下移动与删除，停用不再把整张卡变灰；底部常驻保存条显示「已保存 / 有未保存的修改」并提供预览、撤销与保存（⌘S / Ctrl+S 可保存），保存后自动刷新预览。预览区改为全宽表格 + 全文，可一键复制；空状态、加载、读取/保存/预览失败都有专门的界面。颜色全部走 `--dsw-*` token，亮色、暗色与皮肤主题自动跟随。

### Patch Changes

- d924fe2: 发布包里带上 `CHANGELOG.md`。
