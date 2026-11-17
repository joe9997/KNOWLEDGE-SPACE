// 把整个网页打包成"双击就能打开"的单文件 HTML
// 用法：npm run build:single   → 产出仓库根目录的 KNOWLEDGE-SPACE.html
//
// 为什么要单独做：直接双击 Vite 产出的 dist/index.html 打不开——
// 它用 <script type="module" src="./assets/x.js">，file:// 协议下浏览器会按
// CORS 规则拦截模块脚本。这里改成 IIFE 内联，JSON/CSS/图片全部塞进一个文件。

import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'dist-single');
const finalName = 'KNOWLEDGE-SPACE.html';

await build({
  configFile: false,
  root,
  base: './',
  publicDir: 'public',
  plugins: [react()],
  logLevel: 'warn',
  build: {
    outDir: 'dist-single',
    emptyOutDir: true,
    cssCodeSplit: false,
    // 不让小资源自动内联，统一在这里手动处理，顺序可控
    assetsInlineLimit: 0,
    target: 'es2020',
    rollupOptions: {
      output: {
        format: 'iife',              // 关键：普通脚本，file:// 下能执行
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'app.[ext]',
        manualChunks: undefined,
      },
    },
  },
});

let html = readFileSync(path.join(outDir, 'index.html'), 'utf8');

// 1) 取出 JS 内容。注意不能原地放回 <head>：
//    Vite 原本靠 <script type="module"> 的延迟执行语义，去掉 type 后变成同步脚本，
//    执行时 #root 还没解析出来，React 会直接报 null。所以统一挪到 </body> 之前。
const scripts = [];
html = html.replace(
  /<script[^>]*\ssrc="([^"]+)"[^>]*>\s*<\/script>/g,
  (whole, src) => {
    const file = path.resolve(outDir, src);
    if (!existsSync(file)) return whole;
    scripts.push(readFileSync(file, 'utf8'));
    return '<!-- js 移到底部内联 -->';
  },
);

// 2) 内联 CSS（先把 public 目录里的图片转成 base64）
const toDataUri = (file) => {
  if (!existsSync(file)) return null;
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `data:image/${mime};base64,${readFileSync(file).toString('base64')}`;
};

const publicAssets = path.join(root, 'public', 'assets');
const dayAlpine = toDataUri(path.join(publicAssets, 'day-alpine.jpg'));

html = html.replace(
  /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g,
  (whole, href) => {
    const file = path.resolve(outDir, href);
    if (!existsSync(file)) return whole;
    let css = readFileSync(file, 'utf8');
    if (dayAlpine) {
      // 源码里写的是 url('/assets/day-alpine.jpg')，Vite 会按 base 改写成 ./assets/...
      // 这里不猜前缀，凡是 url() 里指向这张图的都换掉
      css = css.replace(
        /url\((['"]?)[^)]*day-alpine\.jpg\1\)/g,
        `url(${dayAlpine})`,
      );
    }
    return `<style>\n${css}\n</style>`;
  },
);

// 3) 兜底：HTML 里若还有绝对 public 路径，也一并替换
if (dayAlpine) {
  html = html.replace(/\/assets\/day-alpine\.jpg/g, dayAlpine);
}

// 4) 加一句提示，避免有人以为这是线上版本
html = html.replace(
  '<head>',
  '<head>\n  <!-- 单文件离线版：由 npm run build:single 生成，双击即可在浏览器打开 -->',
);

// 5) 把 JS 放到 </body> 前，确保 #root 已经存在
if (scripts.length) {
  const inline = scripts.map((code) => `<script>\n${code}\n</script>`).join('\n');
  html = html.includes('</body>')
    ? html.replace('</body>', `${inline}\n</body>`)
    : html + inline;
}

const outFile = path.join(root, finalName);
writeFileSync(outFile, html, 'utf8');

const sizeKb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
const leftExternal = /(?:src|href)="(?!data:|#)[^"]*\.(?:js|css)"/.test(html);
console.log(`\n生成 ${finalName}  ${sizeKb} KB`);
console.log(leftExternal ? '⚠ 仍有外部 js/css 引用，文件不完整' : '✓ 无外部依赖，可直接双击打开');
