# 实施计划

- [ ] 1. 定义新的类型系统（`src/lib/llm/types.ts`）
   - 新增 `ModelConfig` 接口，包含 `name`、`use`、`model`、`apiKey`、`baseURL`、`supports_thinking`、`when_thinking_enabled`、`modelKwargs`、`patches`、`defaultMaxTokens`、`defaultTemperature`、`defaultTimeout` 字段
   - 新增 `CreateModelOptions` 接口，包含 `thinkingEnabled`、`maxTokens`、`temperature`、`timeout`、`streaming`、`modelKwargs` 等运行时覆盖字段
   - 新增自定义错误类 `ModelResolveError`、`ModelNotFoundError`、`ConfigurationError`
   - 删除旧的 `Provider` 类型和 `ProviderConfig` 接口
   - _需求：1.2、2.3、2.4、3.2、6.1、7.4_

- [ ] 2. 创建模型配置文件（`src/lib/llm/models.config.ts`）
   - 以 TypeScript 数组形式声明所有模型配置（openrouter、qwen、spark）
   - 每个模型配置使用 `"@langchain/openai:ChatOpenAI"` 格式的 `use` 字段
   - API Key 和 baseURL 使用 `"$ENV_VAR_NAME"` 格式引用环境变量
   - qwen 模型配置 `patches: ["dashscope-toolcall-fix"]` 和 `modelKwargs: { enable_thinking: false }`
   - _需求：1.1、1.2、1.3、4.1、5.4_

- [ ] 3. 实现环境变量解析工具函数（`src/lib/llm/resolveEnv.ts`）
   - 实现 `resolveEnvValue(value: string): string` 函数，当值以 `$` 开头时从 `process.env` 读取
   - 对缺失的环境变量在加载时输出 `console.warn` 警告
   - 在实际使用时（被调用时）若环境变量缺失则抛出 `ConfigurationError`
   - _需求：1.3、7.2、7.3_

- [ ] 4. 实现反射式类解析器（`src/lib/llm/classResolver.ts`）
   - 实现 `resolveClass(classPath: string): Promise<any>` 函数
   - 解析 `"module:ClassName"` 格式，使用 `await import(module)` 动态加载
   - 通过 `module[ClassName]` 获取目标类
   - 模块不存在时抛出 `ModelResolveError`（包含模块路径）
   - 类不存在时抛出 `ModelResolveError`（包含类名）
   - 使用 `Map<string, any>` 缓存已解析的类，避免重复 import
   - _需求：2.1、2.2、2.3、2.4、2.5_

- [ ] 5. 实现补丁注册机制（`src/lib/llm/patches.ts`）
   - 定义 `ModelPatch` 类型：`(model: BaseChatModel) => BaseChatModel`
   - 实现 `patchRegistry: Map<string, ModelPatch>`，注册 `"dashscope-toolcall-fix"` 补丁
   - 将 `DashScopeChatOpenAI` 的 monkey-patch 逻辑迁移为独立的补丁函数
   - 实现 `applyPatches(model, patchNames[]): BaseChatModel` 函数
   - _需求：4.1、4.2、4.3、4.4_

- [ ] 6. 实现 Model Factory 核心函数（`src/lib/llm/factory.ts`）
   - 实现 `createChatModel(name: string, options?: CreateModelOptions): Promise<BaseChatModel>`
   - 从 `models.config.ts` 查找模型配置，未找到抛出 `ModelNotFoundError`
   - 调用 `resolveEnvValue` 解析 apiKey 和 baseURL
   - 调用 `resolveClass` 动态加载模型类
   - 合并参数优先级：运行时 options > 配置默认值
   - 处理 `thinkingEnabled`：当模型 `supports_thinking` 为 true 时合并 `when_thinking_enabled`
   - 处理 `baseURL`：设置为 `configuration: { baseURL }` 格式
   - 合并 `modelKwargs`
   - 实例化模型后调用 `applyPatches` 应用补丁
   - _需求：3.1、3.2、3.3、3.4、3.5、3.6、5.1、5.2、5.3_

- [ ] 7. 实现配置加载与验证（`src/lib/llm/configLoader.ts`）
   - 实现 `loadAndValidateConfig()` 函数，启动时调用
   - 验证每个模型的必填字段（name、use、model）
   - 验证 `use` 字段格式符合 `"module:ClassName"` 模式（包含恰好一个 `:`）
   - 环境变量缺失时输出警告而非报错
   - 加载成功后输出日志列出所有已注册模型名称
   - _需求：7.1、7.2、7.4、7.5_

- [ ] 8. 更新模块导出（`src/lib/llm/index.ts`）
   - 删除 `export { buildLLM } from "./apiBuildHandler"`
   - 删除 `export type { Provider, LLMOptions, ProviderConfig } from "./types"`
   - 新增 `export { createChatModel } from "./factory"`
   - 新增 `export type { ModelConfig, CreateModelOptions } from "./types"`
   - 确保 `src/lib/index.ts` 的 re-export 同步更新
   - _需求：6.4_

- [ ] 9. 迁移所有调用方
   - [ ] 9.1 迁移 `src/agents/ChatAgentServer.ts`
      - 将 `import { buildLLM } from "@/lib"` 改为 `import { createChatModel } from "@/lib"`
      - 将 `buildLLM("qwen", this.config)` 改为 `await createChatModel("qwen", { ... })`
      - `buildAgent()` 方法改为 `async buildAgent()`，构造函数中改为异步初始化
      - _需求：6.2、6.3_
   - [ ] 9.2 迁移 `src/agents/SearchAgentServer.ts`
      - 同 9.1 的修改模式
      - _需求：6.2、6.3_
   - [ ] 9.3 迁移 `src/agents/harness/AgentHarness.ts`
      - 将 `buildLLM(modelConfig.provider as any, {...})` 改为 `await createChatModel(modelConfig.name || "qwen", {...})`
      - 移除 `provider` 字段的使用，改为直接传模型配置名称
      - _需求：6.2、6.3_

- [ ] 10. 删除旧代码并清理
   - 删除 `src/lib/llm/apiBuildHandler.ts` 整个文件
   - 从 `types.ts` 中移除已废弃的 `Provider`、`LLMOptions`（如果 CreateModelOptions 已完全替代）、`ProviderConfig`
   - 确认项目中不存在任何对 `ChatOpenAI` 的直接 import（`grep` 验证）
   - 确认项目中不存在任何对 `buildLLM` 的引用（`grep` 验证）
   - _需求：6.1、6.5_
