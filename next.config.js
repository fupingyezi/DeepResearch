/** @type {import('next').NextConfig} */
const nextConfig = {
  // 注：Next 14 的 Turbopack 在 API 路由场景下存在请求挂起问题（dev 下可慢到 10s+），
  // 暂时回退到 webpack；待升级到 Next 15 stable 后再考虑重新开启。

  // 性能优化
  swcMinify: true,

  // 自托管容器化：产出 .next/standalone 精简运行时，供 Docker runner 阶段直接 `node server.js`
  output: 'standalone',

  // 图片优化
  images: {
    domains: ['localhost'],
  },
};

module.exports = nextConfig;
