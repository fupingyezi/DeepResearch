# 中间件装配的 YAML 配置（config.yaml）

中间件装配遵循字节 deer-flow 2.0 的 `config.yaml` 约定。本仓库默认文件为根目录 `config.yaml`（提交入库，全量值便于审计）；部署时可用 `DEERFLOW_CONFIG_PATH` 指向自定义路径，或直接修改后热生效。

## 约定（对齐 deer-flow 2.0）

**顺序不写在 YAML 里。** 装配顺序是 harness `factory.ts` 的代码固定 append 列表（`ORDERED_MIDDLEWARES` 位序），YAML 只承担三件事：

1. **各中间件专属选项块的 `enabled` 开关与参数**（summarization / loop_detection / guardrails / title / memory / sandbox / todo / thread_data / uploads / subagent_limit）
2. **`extensions.middlewares`** 自定义中间件模块路径列表（启动时解析注册）
3. **runtime 门控不进 YAML**：vision 由模型能力（`supportsVision`）驱动、qwen 工具调用恢复由 provider 自动；恒开安全件（tool_call_integrity / tool_error_handling）没有 `enabled` 键

## 优先级链

```
metadata（单请求，严格 typeof === 'boolean' 才生效，最高）
  > snapshot.enabled（YAML 开关）
  > baseOptions（wiring 构造 DeerFlowClient 时的服务级默认 = YAML 派生）
  > SDK 默认（createDefaultMiddlewareConfigYaml，与 config.yaml 提交值同源）
```

`DEERFLOW_GUARDRAIL_ENABLED` / `DEERFLOW_GUARDRAIL_BLOCK` 降为纯 fallback（YAML 键恒存在时不再生效）；`DEERFLOW_SANDBOX_*` / `TITLE_MODEL` / embedding / rerank 等环境变量不变。

## 热生效与生效边界

- **开关与中间件参数热生效**：签名 = `${mtimeMs}:${sha256(原文).slice(0,16)}` 折入 agent 缓存键（`buildConfigKey` 末位）——改 YAML 保存后，下一轮对话自动按新配置重建 agent。`memoryEnabled=true` 路径本就不缓存，天然即时。
- **仅启动生效**：`extensions.middlewares`（启动时 require 一次进注册表）、`memory` 块载入的 MemoryConfig（`ensureMemoryStorage` 之前载入一次，变更需重启）。
- **$VAR 占位符随进程定格**：解析值不进签名（签名只反映文件内容变化），env 变更需重启进程。占位符未命中替换为空串（与 deer-flow 一致，不留字面量）。

## 失败语义

与 `extensions_config.json` 的「损坏回退空配置」刻意不同：

- **文件缺失** → SDK 默认（启动一次性 info；首次部署的常态，不是错误）
- **文件存在但非法**（YAML 语法错 / 未知键 / 类型错 / config_version 非 1）→ **大声抛错**——装配配置静默降级等于「关护栏」「关循环检测」这类安全配置失效而不自知
- **部分块缺失 / 块内 `enabled` 缺省** → 逐块逐键回落默认（块内 `enabled` 缺省 = true：`loop_detection: { hard_limit: 7 }` 是合法写法）

## 完整 schema

模板与注释见根目录 `config.example.yaml`；全量当前值见 `config.yaml`。各块：

- `summarization`：`trigger_tokens` / `keep_messages`（模型恒用当次 agent 主模型）
- `loop_detection`：`warn_threshold` / `hard_limit` / `window_size` / `tool_freq_warn` / `tool_freq_hard_limit`
- `guardrails`：`block_mode` = none / injection / output / all；`enabled` 同时覆盖「链上挂载」与「扫描开关」两层
- `memory`：`mode` = inject / retrieve（`metadata.memoryMode` 仍可单请求覆盖）+ MemoryConfig 各字段（snake_case）
- `subagent_limit`：`max_concurrent` / `max_total` / `max_tracked_threads`
- `extensions.middlewares`：模块路径列表（见下）

## extensions.middlewares（自定义中间件）

模块路径三种形态：相对路径（以进程 cwd 为锚）/ 绝对路径 / 裸包名（按 cwd 的 node_modules 解析）。加载顺序 = 声明序，注册进 harness 注册表（scope 默认 both），落位规则同 `registerExtraMiddleware`（@Next/@Prev 锚点、无锚落链尾）。

导出形态（提供其一即可）：

- 默认导出 / 命名导出 `middleware`：中间件实例、数组、或工厂函数（可 async）
- 命名导出 `middlewares`：数组
- CJS `module.exports = X` 直出（无 default 键）

任一模块解析失败 → 启动抛错（含 specifier 与部署提示）。**Next standalone 部署的运行期不含源码树**——中间件必须是 node_modules 包或已编译产物，不能用 TS 源码路径。

## 边界分工

- harness（`config/middleware-config.ts`）：schema / parse / $VAR 替换——纯函数收字符串，可单测
- 宿主（`src/backend/config/`）：文件读取与 mtime 缓存（`deerflow-config.ts`）、模块 require（`middleware-loader.ts`）
