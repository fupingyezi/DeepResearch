/** @type {import('next').NextConfig} */
const nextConfig = {
  // 注：Next 14 的 Turbopack 在 API 路由场景下存在请求挂起问题（dev 下可慢到 10s+），
  // 暂时回退到 webpack；待升级到 Next 15 stable 后再考虑重新开启。

  // 性能优化
  swcMinify: true,

  // 图片优化
  images: {
    domains: ['localhost'],
  },
};

module.exports = nextConfig;
