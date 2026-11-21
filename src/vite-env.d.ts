/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 设为 '1' 表示静态部署（无后端），账号使用浏览器本地实现 */
  readonly VITE_STATIC_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
