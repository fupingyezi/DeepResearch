/** @type {import('next').NextConfig} */
const nextConfig = {
  // 注：Next 14 的 Turbopack 在 API 路由场景下存在请求挂起问题（dev 下可慢到 10s+），
  // 暂时回退到 webpack；待升级到 Next 15 stable 后再考虑重新开启。

  // 性能优化
  swcMinify: true,

  // 自托管容器化：产出 .next/standalone 精简运行时，供 Docker runner 阶段直接 `node server.js`
  output: 'standalone',

  // 构建期 lint/typecheck 关闭：这两个校验在 CI quality 门禁里已按同款命令独立执行
  // （deploy job needs quality），docker build 里再跑一遍是纯冗余；且服务器构建与
  // PG/Redis/MinIO/app 同机，build 主进程内的 eslint + 单线程 tsc 是构建里最重的
  // 阶段——关掉后构建只剩 webpack 编译，同机负载与内存峰值都显著下降。
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },

  // 页面数据收集 / 静态生成的兜底超时（秒）。Next 14 默认 0 = 禁用：worker 内一次
  // 卡死（内存风暴假死 / 模块求值异常）会让整个构建无输出地挂到被外层墙钟杀死——
  // 该阶段正常只需几秒，120s 足够宽裕。启用后 Next 对超时调用 SIGTERM 重启 worker
  // 农场并重试（页面数据 2 次 / 静态生成 3 次），仍不行以
  // 「Collecting page data for X is still timing out」明确报错快速失败。
  staticPageGenerationTimeout: 120,

  experimental: {
    // ssh2 及其可选原生依赖（cpu-features）含动态 require，webpack 静态解析会失败；
    // 列为服务端外部包，运行期从 node_modules 直接 require（standalone 会一并追踪拷贝）。
    serverComponentsExternalPackages: ['ssh2', 'cpu-features'],
    // 14.2 下 instrumentation 注册钩子（优雅停机 / 僵尸对账）仍是实验开关；
    // 不开这个 flag，src/instrumentation.ts 不会被编译进产物。
    instrumentationHook: true,
    // 构建 worker 数上限：next build 的页面数据收集 / 静态生成默认 fork 8 个子进程
    // （pages+app 池各 4，jest-worker 构造即 fork），每个都装载完整 app 模块图
    // （langchain 等）——轻量服务器上这个内存尖峰会与同机 PG/Redis/MinIO/app 互挤
    // 触发 swap 风暴（进程活着但几乎不前进，叠加上面超时禁用 = 构建静默挂起）。
    // 缺省不设（CI/本机用 Next 默认并行度），服务器构建经 Dockerfile 注入
    // NEXT_BUILD_CPUS=2 压到 2。
    cpus: process.env.NEXT_BUILD_CPUS ? Number(process.env.NEXT_BUILD_CPUS) : undefined,
  },

  webpack: (config, { nextRuntime }) => {
    // instrumentation 在 14.2 会同时编译 nodejs / edge 两个端点，edge 端点解析不了
    // redis / mcp / pg / minio 依赖的 node 内建模块（stream/net/dns/fs/child_process）。
    // edge 端点在自托管部署（standalone node 服务）从不执行，register() 也带
    // NEXT_RUNTIME 守卫；因此 edge 编译把这两个重依赖入口替换为空模块，只求编译通过。
    // 别名键必须是绝对路径：Next 的 jsconfig-paths 插件在 described-resolve 阶段就
    // 把 '@/' 请求解析成绝对路径，webpack 原生 alias 只对相对/裸模块名生效。
    if (nextRuntime === 'edge') {
      config.resolve.alias = {
        ...config.resolve.alias,
        [`${process.cwd()}/src/deerflow-harness`]: false,
        [`${process.cwd()}/src/server/wiring`]: false,
      };
    }
    return config;
  },

  // 图片优化
  images: {
    domains: ['localhost'],
  },
};

module.exports = nextConfig;
