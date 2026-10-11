# 后端分层结构形态分析（controller / service 统一性审查）

> 分支 `analysis/controller-service-structure`，2026-10-11。
> 起因：controller 为什么「写一堆函数最后又单例导出」、service 为什么「一会统一类一会工厂 return 里放一堆函数」。本文记录形态现状、成因（git 溯源）与统一建议。
> **状态：P0/P1 已实施**（见 §8 实施记录），P2 为可选项。

## 1. 结论摘要

- **Controllers**：14 个文件形态完全统一，但统一在「裸函数 + 底部手工聚合对象」的双重导出上——聚合对象是唯一被消费的 API，单个函数导出是死表面。
- **Services**：三种形态并存——class 工厂（7 个）、interface + 对象字面量工厂（auth/oauth 2 个）、纯函数模块（4 个）。分裂成因是两次独立重构的沉积，四层搬迁（79fdf68）原样继承，未归一。
- 另有 4 处同款漂移：`repositories/user-model-key`（裸函数 vs 其余域的类）、`http/rate-limit.ts` 的 `loginFailures` 对象字面量单例、`lib/oauth` adapter 对象字面量工厂、service 工厂参数写法两种风格。

## 2. 形态矩阵

### Controllers（`src/backend/controllers/`，14 个）

统一形状：

```ts
export const post: ApiRouteHandler<TBody, TQuery> = async ({ user, body, request }) => {...};
// ...更多 handler 裸函数
export const chatController = { post };          // 底部聚合对象
export const authRateLimits = { ... };           // 部分文件另有模块级限流器导出
```

消费面：35 个 route.ts **只 import 聚合对象**（`import { chatController }` → `chatController.post`）。单个 handler 导出无任何非 route 消费者，测试也不 import controller。→ `export const post` 与 `export const chatController` 是双份 API 表面，前者是死的。

### Services（`src/backend/services/`，13 个）

| 形态                                                                             | 文件                                                                                                                                                                          | 说明                                                         |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| A. `export class XService` + `createXService(deps?)` + `getXService()`           | chat、conversation、file、memory、model-key、extension、prompt-enhance（7）                                                                                                   | 构造器注入 deps，公有方法在类体，私有助手为 private 方法     |
| B. `export interface XService` + 工厂 `return { m1, m2, ... }` + `getXService()` | auth、oauth（2）                                                                                                                                                              | 公有方法铺在对象字面量里，私有助手以闭包形式挂在 return 之前 |
| C. 纯函数模块（无类无单例）                                                      | model-config（`resolveUserModelConfig`）、sandbox（`getSandboxStatsSnapshot`）、run-stream-guard（`guardedStream` 生成器）、memory-service.preview（`previewRetrieval`）（4） | 无依赖无状态的函数，不属于 service 却放在 services/ 下       |

## 3. 成因（git 溯源）

- **Services 三种形态先于四层重构存在**。`79fdf68`（2026-10-10，reorganize server into backend）把 `src/server/services/` 整体搬入 `src/backend/services/`，每文件仅改 import 路径（8~22 行），形态原样继承。
- 分裂点：
  - `export class ChatService` ← `2f06b0b`（refactor(server): v3/chat 巨石拆分）
  - `createAuthService` 对象字面量 ← `3697173`（refactor(auth): 会话/邮箱令牌数据访问迁出 harness）
- **Controllers 层是 `79fdf68` 一次性新建的**：41 条 route 的 handler 体按域抽入 14 个文件，因此形态统一——但它出生即带双重导出，同样是一次性决策的产物。
- 结论：不是设计分歧，是两次重构各自选择 + 搬迁时未归一。

## 4. 各形态的具体问题

### 4.1 controller 为什么不用统一的类

handler 按设计是无状态的：`withApiHandler` 把 user/body/params 全喂进 ctx，依赖（service）在 handler 体内经 `getXService()` 惰性获取。没有实例状态、没有需要保护的私有字段，类在此层纯属仪式感，不会带来任何收益。问题不在「没用类」，而在「写了函数又单例导出」——底部的 `chatController = { post }` 是**手工模拟的命名空间**，ESM 本身免费提供 `import * as chatController`。

### 4.2 service 对象字面量工厂（形态 B）的维护成本

- 公有方法边界靠肉眼扫 `return {...}` 块才能分辨，与闭包私有助手（`safeSend`、`sendResetForEmail`）混在同一视线内；
- `AuthService` / `OAuthService` interface 需与实现手动同步，两处维护；
- 无原型，方法不可被继承/覆盖（测试 mock 只能替换整个 deps）；
- 对照形态 A：构造器注入 deps、公有方法在类体、私有助手 private 方法、类型即类本身，四样成本全消。

### 4.3 其余微漂移

- 工厂参数两种写法并存：`deps: X = defaultDeps` 参数默认值（extension/memory/model-key/prompt-enhance）vs `deps?: Partial<X>` + 内部 `?? defaultDeps`（chat/conversation/file），行为一致风格分裂；
- services/ 目录混入 4 个纯函数模块（形态 C），命名与分层含义不符。

## 5. 其他同款位置（排查清单）

| 位置                                            | 现状                                                                                                      | 性质                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `src/backend/repositories/user-model-key/`      | 裸函数（`upsertModelKey` 等），其余 7 个域全是 `PgXxxRepository implements XxxRepository` 类              | 同款分裂，规模 1 文件                                     |
| `src/backend/http/rate-limit.ts`                | `export const loginFailures = { record(){}, clear(){}, isLocked(){} }` 模块级对象字面量单例，连工厂都没包 | 与 auth-service 同款，且直接导出带方法                    |
| `src/backend/lib/oauth/`（4 个 adapter）        | `createGithubAdapter()` 等 return 对象字面量实现 `OAuthProviderAdapter`                                   | 闭包模式与 auth-service 同源                              |
| `src/backend/lib/zhipu-rerank.ts`               | `createZhipuReranker` return `{ rerank }`                                                                 | 单方法，问题最轻                                          |
| `src/backend/harness-adapters/`                 | `export const titleStoreProvider = {...}` 模块级对象字面量                                                | **合理**：全部意义是实现 harness 注入接口，形状由接口决定 |
| `packages/deerflow-harness/agents/middlewares/` | 裸 `createMiddleware({...})` 常量与 `createSummarizationMiddleware(model, opts)` 工厂混用                 | 部分由 LangChain `createMiddleware` API 形状强制，可不动  |

## 6. 统一方案与优先级

| 优先级 | 位置                                    | 方案                                                                                                                                             | 代价                           |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| P0     | services 形态 B（auth/oauth）           | 改 class（形态 A）。`createAuthService(deps)` 签名不变，现有测试（均 import 工厂）不动；`AuthService`/`OAuthService` interface 折叠成 class 类型 | 2 文件，机械                   |
| P0     | controllers 双导出                      | 保留裸函数，删底部聚合对象，route.ts 改 `import * as chatController`                                                                             | 35 个 route.ts 各改一行 import |
| P1     | `repositories/user-model-key`           | 改类，对齐其余域                                                                                                                                 | 1 文件                         |
| P1     | `http/rate-limit.ts` 的 `loginFailures` | 拆成三个命名函数（lib 层全项目就是裸函数风格）                                                                                                   | 1 文件                         |
| P2     | `lib/oauth` adapters                    | 改类或维持（闭包很小，收益低）                                                                                                                   | 可选                           |
| P2     | 工厂参数写法                            | 统一为 `deps?: Partial<X>` + `??`                                                                                                                | 顺手改                         |
| 不动   | harness middlewares / harness-adapters  | 形状由外部 API / 注入接口决定                                                                                                                    | —                              |

## 7. 迁移影响评估

- 服务侧：测试文件 import 的是 `createXService` / `createOAuthService`（`services/__tests__/`），工厂签名保持则测试零改动；类转换后 private 助手变成私有方法，对外行为不变。
- 路由侧：route.ts 从具名 import 改 namespace import，`xxxController.post` 引用点不变，仅 import 行；`xxxRateLimits` 是独立导出不受影响。
- 建议与四层重构同款节奏：分阶段提交（services → controllers → repositories/lib），每阶段 `pnpm lint && pnpm typecheck && pnpm test` 门禁。

## 8. 实施记录

| 阶段 | commit    | 内容                                                                                                                                                               |
| ---- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0a  | `75bee63` | auth/oauth service 从 interface + 对象字面量工厂改为 class（`AuthService`/`OAuthService` 接口折叠成 class 类型；工厂签名与消费者不变）                             |
| P0b  | `4e9d1f2` | 14 个 controller 删除尾部聚合对象导出；41 个 route.ts 改 `import * as xxxController`，附加导出（`xxxRateLimits` / `parseUploadBody` / `isAuthorized`）保留具名导入 |
| P1a  | `5fcf4e8` | user-model-key 仓库改类：`types.ts` 契约 + `PgUserModelKeyRepository` + index 桶；model-key-service deps 改仓库接口、model-config-service 经模块级实例调用         |
| P1b  | `328d928` | `loginFailures` 对象字面量拆为 `recordLoginFailure` / `clearLoginFailures` / `isLoginLocked` 命名函数                                                              |

P2（`lib/oauth` adapters 改类、工厂参数写法统一）未实施，收益低，维持现状。

实施后统一形态（已固化进 CLAUDE.md「后端分层规范」）：

- controllers：裸 handler 函数导出，route.ts 经 namespace import 消费；
- services：`export class XService` + `createXService(deps?)` + 模块级懒单例 `getXService()`；
- repositories：每域 types.ts 契约 + `PgXxxRepository implements` 类 + index 桶。
