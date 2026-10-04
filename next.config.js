/** @type {import('next').NextConfig} */
const nextConfig = {
  // 注：Next 14 的 Turbopack 在 API 路由场景下存在请求挂起问题（dev 下可慢到 10s+），
  // 暂时回退到 webpack；待升级到 Next 15 stable 后再考虑重新开启。

  // 性能优化
  swcMinify: true,

  // 自托管容器化：产出 .next/standalone 精简运行时，供 Docker runner 阶段直接 `node server.js`
  output: 'standalone',

  experimental: {
    // ssh2 及其可选原生依赖（cpu-features）含动态 require，webpack 静态解析会失败；
    // 列为服务端外部包，运行期从 node_modules 直接 require（standalone 会一并追踪拷贝）。
    serverComponentsExternalPackages: ['ssh2', 'cpu-features'],
    // 14.2 下 instrumentation 注册钩子（优雅停机 / 僵尸对账）仍是实验开关；
    // 不开这个 flag，src/instrumentation.ts 不会被编译进产物。
    instrumentationHook: true,
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
