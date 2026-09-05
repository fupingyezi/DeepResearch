# 多阶段构建：deps 装依赖、builder 产出 standalone、runner 精简运行时
# 目标是让 runner 层只包含运行 Next.js standalone 所需的最小文件集，
# 依赖层与源码层分离以最大化 Docker layer 缓存命中。

# ---- deps：仅随 lockfile 变化而失效，缓存命中率高 ----
FROM node:22-slim AS deps
WORKDIR /app
# corepack 固定 pnpm，避免全局安装带来的版本漂移
RUN corepack enable && corepack prepare pnpm@11 --activate
# 国内服务器构建：npm 走阿里镜像源，官方源在境内几乎不可用
ENV npm_config_registry=https://registry.npmmirror.com
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---- builder：编译产出 .next/standalone ----
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 构建期不需要真实业务密钥；standalone 产物在运行期由 env_file 注入配置
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- runner：仅拷贝 standalone 运行所需文件，非 root 运行 ----
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# 降权：使用内置 node 用户，避免容器内 root
# standalone 的 server.js 会自带精简 node_modules，无需再装依赖
COPY --from=builder /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# 预建运行期数据目录并置 node 属主：named volume 挂载到"镜像中已存在且属 node"的
# 目录时，copy-up 会继承该属主；否则全新卷由 Docker 以 root 创建，容器内 node
# 用户写入即 EACCES（曾导致记忆更新静默失败）
RUN mkdir -p .memory .data .sandbox skills/custom \
    && chown -R node:node .memory .data .sandbox skills

USER node
EXPOSE 3000

CMD ["node", "server.js"]
