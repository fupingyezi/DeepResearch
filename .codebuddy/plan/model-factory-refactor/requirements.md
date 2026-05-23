# 需求文档：Model Factory 反射配置重构

## 引言

当前 mini-DeepResearch 项目的 LLM 模块（`src/lib/llm/apiBuildHandler.ts`）直接硬编码使用 `ChatOpenAI` 类来创建模型实例，通过 `Provider` 枚举区分不同提供商（openrouter、qwen、spark），并在代码中硬编码各提供商的配置逻辑。

参照 DeerFlow 的架构设计，本次重构的目标是：
1. **去除对 ChatOpenAI 的直接依赖**，改为通过配置文件声明模型类路径，运行时动态实例化
2. **引入配置文件**，以 `"module:Class"` 格式声明 LangChain 模型类
3. **实现反射式 Model Factory**，通过 TypeScript 动态 `import()` 解析配置中的类路径并实例化
4. **支持 Thinking 模式条件注入**，通过配置声明 `supports_thinking` 和 `when_thinking_enabled` 字段
5. **完全迁移**，删除旧的 `buildLLM()` 函数和相关类型，所有调用方统一使用新 API

### 当前架构问题

| 问题 | 描述 |
|------|------|
| 硬编码耦合 | `buildLLM()` 直接 import `ChatOpenAI`，新增提供商需改代码 |
| Provider 枚举固定 | 新增提供商需修改 `types.ts` 的 `Provider` 类型 |
| 配置分散 | 环境变量命名不统一，配置逻辑散落在代码中 |
| DashScope 子类硬编码 | `DashScopeChatOpenAI` 的 monkey-patch 逻辑与工厂耦合 |
| 无 Thinking 模式管理 | 缺乏统一的 thinking/reasoning 模式配置 |

---

## 需求

### 需求 1：模型配置文件

**用户故事：** 作为一名开发者，我希望通过配置文件声明所有可用的 LLM 模型及其参数，以便无需修改代码即可新增或切换模型提供商。

#### 验收标准

1. WHEN 项目启动 THEN 系统 SHALL 从 `src/lib/llm/models.config.ts` 加载模型配置列表
2. IF 配置文件中声明了一个模型 THEN 该模型配置 SHALL 包含以下字段：
   - `name`：模型唯一标识（如 `"qwen-plus"`）
   - `use`：LangChain 模型类的模块路径（如 `"@langchain/openai:ChatOpenAI"`）
   - `model`：实际模型名称（如 `"qwen-plus"`）
   - `apiKey`：API Key（支持环境变量引用，如 `"$OPENAI_QWEN_API_KEY"`）
   - `baseURL`：可选，API 基础 URL（支持环境变量引用）
   - `supports_thinking`：可选，是否支持思考模式
   - `when_thinking_enabled`：可选，启用思考模式时的额外参数
   - `modelKwargs`：可选，额外的模型参数
   - `patches`：可选，需要应用的补丁列表
   - `defaultMaxTokens`：可选，默认最大 token 数
   - `defaultTemperature`：可选，默认温度
   - `defaultTimeout`：可选，默认超时时间
3. WHEN 配置文件中的字段值以 `$` 开头 THEN 系统 SHALL 将其解析为对应的环境变量值
4. IF 配置文件不存在或格式错误 THEN 系统 SHALL 抛出明确的错误信息并阻止启动

### 需求 2：反射式类解析器（Class Resolver）

**用户故事：** 作为一名开发者，我希望系统能根据配置中的模块路径字符串动态加载 LangChain 模型类，以便实现零硬编码依赖。

#### 验收标准

1. WHEN 系统需要实例化模型 THEN 系统 SHALL 解析 `"module:ClassName"` 格式的字符串（如 `"@langchain/openai:ChatOpenAI"`）
2. WHEN 解析类路径 THEN 系统 SHALL 使用 TypeScript 的动态 `import()` 加载模块，并通过属性访问获取目标类
3. IF 模块路径无法解析（模块不存在） THEN 系统 SHALL 抛出 `ModelResolveError` 并包含模块路径信息
4. IF 目标类在模块中不存在 THEN 系统 SHALL 抛出 `ModelResolveError` 并包含类名信息
5. WHEN 成功解析类 THEN 系统 SHALL 缓存解析结果，避免重复动态导入

### 需求 3：Model Factory 重构

**用户故事：** 作为一名开发者，我希望通过新的 `createChatModel(name, options?)` 函数从配置文件读取模型定义并通过反射实例化，以便彻底解耦模型创建逻辑与具体提供商实现。

#### 验收标准

1. WHEN 调用 `createChatModel(name, options?)` THEN 系统 SHALL：
   - 从配置中查找 `name` 对应的模型配置
   - 通过 Class Resolver 动态加载模型类
   - 合并配置参数和运行时 options
   - 实例化并返回 LangChain `BaseChatModel` 实例
2. IF 请求的模型名称在配置中不存在 THEN 系统 SHALL 抛出 `ModelNotFoundError`
3. WHEN `options.thinkingEnabled` 为 true 且模型配置中 `supports_thinking` 为 true THEN 系统 SHALL 将 `when_thinking_enabled` 中的参数合并到实例化参数中
4. WHEN 模型配置中包含 `modelKwargs` 字段 THEN 系统 SHALL 将其合并到模型实例化参数中
5. IF 模型配置中包含 `baseURL` THEN 系统 SHALL 将其设置为 `configuration.baseURL`（兼容 ChatOpenAI 的配置方式）
6. WHEN 运行时 options 中传入 `maxTokens`、`temperature`、`timeout`、`streaming` 等参数 THEN 系统 SHALL 用运行时参数覆盖配置中的默认值

### 需求 4：DashScope 兼容性处理

**用户故事：** 作为一名开发者，我希望 DashScope API 的兼容性修复（空 tool_call id）能以插件/补丁方式配置，而非硬编码在工厂函数中。

#### 验收标准

1. WHEN 模型配置中声明了 `patches` 字段（如 `patches: ["dashscope-toolcall-fix"]`） THEN 系统 SHALL 在实例化后应用对应的补丁逻辑
2. IF 模型使用 DashScope API THEN 系统 SHALL 自动修复 tool_call 返回空 id 的问题
3. WHEN 补丁逻辑被应用 THEN 系统 SHALL 不影响其他非 DashScope 模型的正常工作
4. IF 未来 DashScope 修复了此问题 THEN 开发者 SHALL 能通过移除配置中的 `patches` 字段来禁用补丁，无需修改代码

### 需求 5：Thinking 模式管理

**用户故事：** 作为一名开发者，我希望能通过配置声明模型的思考模式支持情况和启用参数，以便统一管理不同模型的 reasoning 能力。

#### 验收标准

1. WHEN 模型配置中 `supports_thinking` 为 true THEN 系统 SHALL 标记该模型支持思考模式
2. WHEN 调用 `createChatModel(name, { thinkingEnabled: true })` 且模型支持思考模式 THEN 系统 SHALL 将 `when_thinking_enabled` 配置合并到实例化参数
3. IF 模型不支持思考模式但请求启用 THEN 系统 SHALL 忽略 thinking 参数并正常实例化模型
4. WHEN qwen 模型默认开启思考模式需要关闭时 THEN 系统 SHALL 通过 `modelKwargs.enable_thinking: false` 配置实现，而非硬编码

### 需求 6：完全迁移（删除旧 API）

**用户故事：** 作为一名开发者，我希望彻底删除旧的 `buildLLM()` 函数及相关类型定义，所有调用方统一使用新的 `createChatModel()` API，以保持代码库整洁。

#### 验收标准

1. WHEN 重构完成 THEN 系统 SHALL 删除以下旧文件/代码：
   - `src/lib/llm/apiBuildHandler.ts`（整个文件）
   - `src/lib/llm/types.ts` 中的 `Provider` 类型和 `ProviderConfig` 接口
   - `DashScopeChatOpenAI` 类（逻辑迁移到 patches 机制中）
2. WHEN 重构完成 THEN 所有调用方 SHALL 直接使用 `createChatModel(modelName, options)` 替代 `buildLLM(provider, options)`
3. IF `ChatAgentServer`、`SearchAgentServer`、`AgentHarness` 等调用 `buildLLM()` THEN 这些代码 SHALL 全部改为调用 `createChatModel()`
4. WHEN `lib/llm/index.ts` 更新导出 THEN 系统 SHALL 导出 `createChatModel` 和新的类型定义（`ModelConfig`、`CreateModelOptions`）
5. WHEN 迁移完成 THEN 项目中 SHALL 不存在任何对 `ChatOpenAI` 的直接 import（所有模型类通过反射加载）

### 需求 7：配置验证与错误处理

**用户故事：** 作为一名开发者，我希望系统在启动时验证模型配置的完整性和正确性，以便尽早发现配置错误。

#### 验收标准

1. WHEN 系统加载配置 THEN 系统 SHALL 验证每个模型配置的必填字段（name、use、model）
2. IF 配置中引用的环境变量不存在 THEN 系统 SHALL 在启动时输出警告日志（而非直接报错，因为可能该模型不会被使用）
3. WHEN 首次使用某个模型时环境变量缺失 THEN 系统 SHALL 抛出 `ConfigurationError` 并明确指出缺失的环境变量名
4. IF `use` 字段格式不符合 `"module:ClassName"` 模式 THEN 系统 SHALL 在加载时抛出格式错误
5. WHEN 配置加载成功 THEN 系统 SHALL 输出日志列出所有已注册的模型名称
