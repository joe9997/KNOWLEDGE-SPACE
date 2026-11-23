import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// 每次 dev server 启动生成一个构建戳：旧标签页据此检测到自己停留在旧 bundle 上
const devBuildStamp = Date.now().toString(36);

function devBuildStampPlugin(): Plugin {
  return {
    name: 'huiyuan-dev-build-stamp',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev_build_stamp', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(devBuildStamp);
      });
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { name: 'dev-build-stamp', content: devBuildStamp },
          injectTo: 'head',
        },
      ];
    },
  };
}

export default defineConfig({
  // 相对路径：本地 / 局域网 / GitHub Pages 的 /<repo>/ 子路径都能直接跑
  base: './',
  plugins: [react(), devBuildStampPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // 端口被旧进程占用时直接报错，而不是偷偷换到 5174 让 5173 继续跑旧版本
    strictPort: true,
    watch: {
      // 编辑器 / 工具的原子写入会先落成 ".<name>.<pid>.<uuid>.tmpdir/<name>.tmp"，
      // 这类临时文件被锁住时会让 chokidar 抛 EBUSY 直接崩掉 dev server。
      ignored: ['**/*.tmpdir/**', '**/*.tmp', '**/data/users/**'],
    },
    proxy: {
      // 本地后端（npm run dev:server）默认监听 3001
      '/api': 'http://127.0.0.1:3001',
    },
  },
});
