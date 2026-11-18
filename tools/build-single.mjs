// 把整个网页打包成"双击就能打开"的单文件 HTML
// 用法：npm run build:single   → 产出仓库根目录的 KNOWLEDGE-SPACE.html
//
// 为什么要单独做：直接双击 Vite 产出的 dist/index.html 打不开——
// 它用 <script type="module" src="./assets/x.js">，file:// 协议下浏览器会按
// CORS 规则拦截模块脚本。这里改成 IIFE 内联，JSON/CSS/图片全部塞进一个文件。
//
// 注意（别删）：下面的 escapeScript / escapeStyle 和 insertBeforeBodyEnd 是必须的。
// React 的产物里带 innerHTML="<script><\/script>" 这样的字面量，不转义就会让浏览器
// 提前闭合 <script> 标签，剩下的 JS 全变成文本 → 整页白屏。这个坑踩过一次。

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
//
// 转义：JS/CSS 里可能出现 "</script" / "</style" 字面量（React 的 key 转义常量里就有
// "</body>"），直接塞进 <script>/<style> 会让 HTML 解析器提前闭合标签、整页白屏。
// 在 JS 字符串 / 正则里 "<\/script" 与 "</script" 等价，所以这层转义是安全的。
const escapeScript = (s) => s.replace(/<\/script/gi, '<\\/script');
const escapeStyle = (s) => s.replace(/<\/style/gi, '<\\/style');

// 只替换文件末尾那一个 </body>：内联进 JS 之后，文档里会多出别的 </body> 字面量
const insertBeforeBodyEnd = (doc, chunk) => {
  const i = doc.lastIndexOf('</body>');
  return i >= 0 ? doc.slice(0, i) + chunk + doc.slice(i) : doc + chunk;
};

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
    return `<style>\n${escapeStyle(css)}\n</style>`;
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
  const inline = scripts
    .map((code) => `<script>\n${escapeScript(code)}\n</script>`)
    .join('\n');
  html = insertBeforeBodyEnd(html, `${inline}\n`);
}

// 6) file:// 打开时贴一条横幅：单文件版不含后端，登录必然失败
//    只在空环境下生效，不影响 npm run dev / Pages 线上版
const offlineNotice = `<script>
(function () {
  if (location.protocol !== 'file:') return;
  var bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:10px 16px;font:13px/1.7 system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#7c2d12;color:#fff;text-align:center;box-shadow:0 -2px 12px rgba(0,0,0,.35)';
  bar.innerHTML = '离线单文件版：<b>只打包了前端，没有后端，登录不会成功</b>。要看完整功能请运行 <code style="background:rgba(255,255,255,.18);padding:1px 5px;border-radius:4px">npm run dev:all</code> 后访问 http://127.0.0.1:5173';
  document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(bar); });
})();
</script>`;
html = insertBeforeBodyEnd(html, `${offlineNotice}\n`);

const outFile = path.join(root, finalName);
writeFileSync(outFile, html, 'utf8');

const sizeKb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
const leftExternal = /(?:src|href)="(?!data:|#)[^"]*\.(?:js|css)"/.test(html);
console.log(`\n生成 ${finalName}  ${sizeKb} KB`);
console.log(leftExternal ? '⚠ 仍有外部 js/css 引用，文件不完整' : '✓ 无外部依赖，可直接双击打开');
