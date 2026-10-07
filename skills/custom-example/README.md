# custom skill 示例模板

本目录是**自定义 skill 的完整示例**（obsidian-rag：本地笔记库 RAG 问答），演示三层渐进披露的完整形态。**不参与加载**——skill loader 只扫描 `skills/public` 与 `skills/custom`，本目录纯粹是模板，复制出去才能用。

## 目录结构（一个 skill = 一个目录）

```
obsidian-rag/
├── SKILL.md                  # frontmatter（name/description）+ 精简正文
├── references/               # 只读知识：模型经 skill 工具按需读取
│   ├── query-guide.md
│   └── mcp-integration.md
└── scripts/                  # 可执行脚本：action="run" 时复制进沙箱 workspace 执行
    ├── rag-index.sh
    ├── rag-ask.sh
    ├── rag-serve.sh          # 幂等启动常驻服务（nohup + pidfile + 健康等待）
    ├── rag-kill.sh           # 停止服务（pidfile → pkill 兜底 → 端口清场）
    └── rag-stats.sh
```

- **frontmatter 的 `description` 是唯一触发面**：系统提示只注入 name + description + 资源目录（L1），正文与 references 由模型判断任务匹配后经 `skill` 工具读取（L2）
- 脚本带 `#!` shebang，运行要求见下；写新 skill 的脚本可参考这里的 env 覆盖 + 失败友好报错 + 幂等模式

## 怎么用（三步）

1. **复制并改名**：

   ```bash
   cp -R skills/custom-example/obsidian-rag skills/custom/<你的技能名>
   ```

   自定义 skill 属运行期状态（`skills/custom` 已 gitignore），改 `SKILL.md` 的 frontmatter 与正文、增删 references/scripts 即可。

2. **启用**：在 `extensions_config.json` 的 `skills` map 加一条 `"<你的技能名>": { "enabled": true }`（custom skill 默认 opt-in 禁用）。服务器侧改文件下次加载生效（缓存键含目录 mtime），无需重启。

3. **配置运行前提**（应用 `.env`）：
   - `DEERFLOW_ALLOW_HOST_BASH=1` —— 必设。skill 脚本经沙箱执行，local 后端即宿主 bash，默认关闭，未开时 `action="run"` 降级为返回脚本内容而不执行
   - `DEERFLOW_SKILL_SCRIPT_TIMEOUT_MS=120000` —— 建议。本示例的 `ask` 内含 LLM 生成，默认 60s 会超时拿不到结果
   - `OBSIDIAN_RAG_DIR=/path/to/obsidian-rag` —— 示例模板**不内置默认路径**，脚本启动前必须设置（或直接把脚本里的 `:?` 行换成本机路径）

## 与 MCP 的关系（本示例的取巧点）

`rag-serve.sh` / `rag-kill.sh` 管理 `obsidian-rag` 的 HTTP MCP 服务生命周期，但 **MCP 工具只在每轮对话开始时加载一次**——对话中途起服务只能惠及后续对话。因此脚本里 `rag-ask.sh` 直连 CLI 作为本轮可用的主查询路径，不依赖 MCP 连接状态。给需要「起服务 → 用 → 杀服务」的技能设计脚本时，同样要考虑**加载时序与本轮可用性**，别把本轮的活压在「下一轮才生效」的入口上。
