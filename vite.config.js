import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';

export default defineConfig({
  base: './',
  // 不用 publicDir：避免把仓库里 public/ 的内容覆盖进 dist/
  publicDir: false,
  server: {
    host: '0.0.0.0',
    // 开发时把函数接口和代理转发到本地的 release/server（npm run serve）
    proxy: {
      '/api': 'http://localhost:6868',
      '/api-proxy': 'http://localhost:6868',
    },
  },
  build: {
    // 构建产物直接输出到 release/dist，和 release/server、release/deploy 一起整体拷到服务器
    outDir: 'release/dist',
    emptyOutDir: true, // 只清空 release/dist，不会动 release 里的其他文件
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        panel: fileURLToPath(new URL('./panel.html', import.meta.url)),
      },
    },
  },
});
