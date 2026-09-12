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
  },

  // 图片优化
  images: {
    domains: ['localhost'],
  },
};

module.exports = nextConfig;
