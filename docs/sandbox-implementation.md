# Sandbox 系统实现总结

> 基于宿主文件系统的 LocalSandbox。

## 1. 概述

### 1.1 功能特性

- **隔离工作区**：按会话隔离的 `/mnt/user-data/{workspace,uploads,outputs}`
- **7 个文件工具**：read_file / write_file / str_replace / ls / glob / grep / bash
- **安全设计**：路径穿越防护、输出脱敏、bash 默认禁用
- **惰性初始化**：工具自行获取沙箱，不依赖中间件预置 state

### 1.2 设计决策

| 决策项        | 选择                      | 理由                           |
| ------------- | ------------------------- | ------------------------------ |
| Provider 范围 | 仅 LocalSandbox           | 轻量，宿主机文件系统直接操作   |
| bash 工具     | 默认禁用，env 开启        | RCE 风险，需显式授权           |
| 默认启用      | features.sandbox=true     | 对齐 deer-flow，服务级默认开启 |
| 抽象保留      | Sandbox / Provider 抽象类 | 便于将来扩展 Docker 隔离       |

---

## 2. 文件结构

```
src/deerflow-harness/sandbox/
├── index.ts                      # 统一出口
├── exceptions.ts                 # 错误体系
├── sandbox.ts                    # Sandbox 抽象基类
├── sandbox-provider.ts           # Provider 抽象 + 单例工厂
├── paths.ts                      # 目录解析
├── path-utils.ts                 # 虚拟路径映射/校验/脱敏
├── security.ts                   # bash 门控
├── search.ts                     # glob/grep
├── list-dir.ts                   # 树形列目录
├── file-operation-lock.ts       # 文件锁
├── tools.ts                      # 7 个 LangChain Tool
└── local/
    ├── local-sandbox.ts         # LocalSandbox 实现
    └── local-sandbox-provider.ts # Provider 单例
```

**改造文件**（已有代码）：

- `src/deerflow-harness/agents/middlewares/sandbox-middleware.ts` — 实现生命周期
- `src/deerflow-harness/agents/middlewares/thread-data-middleware.ts` — 计算真实目录
- `src/deerflow-harness/agents/factory.ts` — 挂载中间件 + 注入工具
- `src/deerflow-harness/agents/lead-agent/prompt.ts` — 增补工具说明
- `src/deerflow-harness/client.ts` — 新增 sandboxEnabled
- `src/deerflow-harness/types/index.ts` — 新增 ClientOptions.sandboxEnabled
- `src/deerflow-harness/tools/index.ts` — 注册 SANDBOX_TOOLS
- `src/deerflow-harness/index.ts` — 导出公共 API
- `src/app/api/threads/_service.ts` — 服务级默认开启
- `.gitignore` — 新增 `/.sandbox`

---

## 3. 核心设计

### 3.1 虚拟路径映射

**设计**：Agent 看到 `/mnt/user-data/workspace/main`，实际操作为 `{cwd}/.sandbox/threads/{threadId}/user-data/workspace/main`

**映射规则**：

| 虚拟路径                   | 本地路径                                        |
| -------------------------- | ----------------------------------------------- |
| `/mnt/user-data/workspace` | `{base}/threads/{threadId}/user-data/workspace` |
| `/mnt/user-data/uploads`   | `{base}/threads/{threadId}/user-data/uploads`   |
| `/mnt/user-data/outputs`   | `{base}/threads/{threadId}/user-data/outputs`   |

**关键函数**（`path-utils.ts`）：

- `virtualToLocal(virtualPath, threadId)` — 虚拟路径 → 本地路径
- `localToVirtual(localPath, threadId)` — 本地路径 → 虚拟路径（脱敏）
- `validateVirtualPath(virtualPath, allowedDirs)` — 路径校验（防穿越）
- `validateBashCommandPaths(command, allowedDirs)` — bash 路径白名单

### 3.2 惰性初始化

**问题**：Subagent 不跑 `SandboxMiddleware`，state 中可能没有 sandbox。

**方案**：工具内部自行获取（对齐 deer-flow `ensure_sandbox_initialized`）

```typescript
async function ensureSandboxInitialized(runtime: ToolRuntime): Promise<LocalSandbox> {
  // 1. 尝试从 state.sandbox 获取
  if (runtime.state?.sandbox) return runtime.state.sandbox;

  // 2. 从 thread_id 获取
  const threadId = runtime.config?.configurable?.thread_id;

  // 3. 通过 Provider 获取/创建
  const provider = getSandboxProvider();
  let sandbox = await provider.get(`sandbox-${threadId}`);
  if (!sandbox) sandbox = await provider.create(threadId);

  // 4. 写回 state
  if (runtime.state) runtime.state.sandbox = sandbox;
  return sandbox;
}
```

### 3.3 中间件装配

**位序**（`factory.ts`）：

```
threadData(0) → uploads(1) → sandbox(2) → toolCallIntegrity(3) → ...
```

**挂载逻辑**：

```typescript
// factory.ts
if (features.sandbox === true) {
  chain.push(sandboxMiddleware);
  for (const t of SANDBOX_TOOLS) extraTools.push(t);
}
```

**SandboxMiddleware 生命周期**：

- `beforeAgent`：获取/复用 sandbox，写回 `state.sandbox`
- `afterAgent`：释放资源（可选）

---

## 4. 安全设计

### 4.1 路径安全

| 威胁            | 防护措施                                |
| --------------- | --------------------------------------- |
| 路径穿越 (`..`) | `path.resolve` 后校验是否落在允许目录内 |
| 绝对路径越界    | 必须以 `/mnt/user-data` 开头            |
| symlink 越界    | 解析真实路径后二次校验                  |
| `file://` 协议  | 拒绝包含 `file://` 的路径               |

**实现**（`path-utils.ts`）：

```typescript
function validateVirtualPath(virtualPath: string, allowedDirs: string[]): string {
  // 1. 必须以 /mnt/user-data 开头
  if (!virtualPath.startsWith(VIRTUAL_PATH_PREFIX)) {
    throw new SandboxPermissionError(`路径必须以 ${VIRTUAL_PATH_PREFIX} 开头`);
  }

  // 2. 转换为本地路径
  const localPath = virtualToLocal(virtualPath, threadId);

  // 3. 校验落在允许目录内
  const isAllowed = allowedDirs.some((dir) => isPathInside(localPath, dir));
  if (!isAllowed) {
    throw new SandboxPermissionError(`路径越界: ${virtualPath}`);
  }

  return localPath;
}
```

### 4.2 bash 安全

| 威胁       | 防护措施                                     |
| ---------- | -------------------------------------------- |
| 未授权执行 | 默认禁用，需 `DEERFLOW_ALLOW_HOST_BASH=true` |
| 命令注入   | 使用 `execFile` (非 shell 字符串拼接)        |
| 路径越界   | 校验命令中的绝对路径在白名单内               |

**实现**（`security.ts`）：

```typescript
function isHostBashAllowed(): boolean {
  return process.env.DEERFLOW_ALLOW_HOST_BASH === 'true';
}
```

### 4.3 输出脱敏

**问题**：工具输出可能泄露宿主目录结构。

**方案**：所有工具输出经过 `maskLocalPaths()` 反向替换（`path-utils.ts`）。

---

## 5. 配置项

### 5.1 环境变量

| 变量                       | 默认值           | 说明               |
| -------------------------- | ---------------- | ------------------ |
| `DEERFLOW_SANDBOX_DIR`     | `{cwd}/.sandbox` | 沙箱根目录         |
| `DEERFLOW_ALLOW_HOST_BASH` | `false`          | 是否允许 bash 工具 |

### 5.2 运行时配置

**ClientOptions**（`types/index.ts`）：

```typescript
interface ClientOptions {
  sandboxEnabled?: boolean; // 新增
}
```

**服务级默认**（`_service.ts`）：

```typescript
const sharedClientOptions = {
  sandboxEnabled: true, // 默认开启
};
```

**请求级覆盖**（`client.ts`）：

```typescript
// metadata 中可以覆盖
const opts: RuntimeRunOptions = {
  sandboxEnabled: pickBooleanOverride(metadata?.sandboxEnabled, !!this.baseOptions.sandboxEnabled),
};
```

---

## 6. 工具使用说明

### 6.1 虚拟路径约定

Agent 必须使用 `/mnt/user-data` 下的绝对路径：

- `/mnt/user-data/workspace` — 主工作目录
- `/mnt/user-data/uploads` — 用户上传文件
- `/mnt/user-data/outputs` — 最终产出物

### 6.2 工具列表

| 工具          | 用途     | 示例                                                                     |
| ------------- | -------- | ------------------------------------------------------------------------ |
| `read_file`   | 读取文件 | `read_file("读取代码", "/mnt/user-data/workspace/main")`                 |
| `write_file`  | 写入文件 | `write_file("保存结果", "/mnt/user-data/outputs/result.txt", "content")` |
| `str_replace` | 替换文本 | `str_replace("修复 bug", "/mnt/user-data/workspace/main", "old", "new")` |
| `ls`          | 列目录   | `ls("查看工作区", "/mnt/user-data/workspace")`                           |
| `glob`        | 查找文件 | `glob("查找 Python 文件", "**/*.py", "/mnt/user-data/workspace")`        |
| `grep`        | 搜索内容 | `grep("查找函数定义", "def main", "/mnt/user-data/workspace")`           |
| `bash`        | 执行命令 | `bash("安装依赖", "pip install requests")`                               |

### 6.3 使用准则

1. **仅在需要时使用**：纯文本回答不要无谓写文件
2. **使用绝对路径**：必须用 `/mnt/user-data/...` 绝对路径
3. **bash 默认禁用**：如返回禁用提示，改用其他文件工具
4. **大文件用 grep**：`read_file` 超过 50KB 会截断，请用 `grep` 检索

---

## 7. 验证结果

### 7.1 构建验证

```bash
✅ pnpm build  # 成功（类型检查通过）
✅ pnpm format:check  # 本次改动文件全部合规
```

### 7.2 黑名单检查

```bash
✅ legacy/deprecated  # 0 匹配
✅ as any  # 0 匹配
✅ 分隔符注释  # 0 匹配
✅ cfg/tcId/Tc  # 0 匹配
```

### 7.3 IDE 诊断

```bash
✅ src/deerflow-harness/sandbox/**  # 0 错误
✅ sandbox-middleware.ts  # 0 错误
✅ thread-data-middleware.ts  # 0 错误
✅ factory.ts  # 0 错误
✅ client.ts  # 0 错误
```

---

## 8. 后续扩展方向

1. **Docker 隔离**：实现 `DockerSandbox` + `DockerSandboxProvider`
2. **Skills 只读挂载**：参考 deer-flow，将 skills 目录只读挂载到沙箱
3. **bash 命令黑名单**：扩展 `security.ts`，支持危险命令检测
4. **文件大小限制**：在 `write_file` 中增加文件大小上限（防 DOS）
5. **操作审计日志**：记录所有文件操作，便于调试与审计

---

## 9. 参考文档

- **project.md**：`/Users/yokotu/code/ai-repo/mini-DeepResearch/project.md`
- **LangChain Tool Runtime**：`@langchain/core/dist/tools/types.d.ts`
