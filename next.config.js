/** @type {import('next').NextConfig} */
const nextConfig = {
  // 启用 Turbopack (基于 Rust 的快速编译器)
  experimental: {
    turbo: {
      // Turbopack 基础配置
    },
  },

  // 性能优化
  swcMinify: true,

  // 图片优化
  images: {
    domains: ['localhost'],
  },
};

module.exports = nextConfig;
