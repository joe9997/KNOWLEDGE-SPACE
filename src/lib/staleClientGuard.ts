const SW_CLEANED_KEY = 'huiyuan.sw-cleaned';

/**
 * 清理历史遗留的 Service Worker / Cache Storage。
 *
 * 127.0.0.1:5173 这个源被多个本地项目反复使用过，如果旧项目注册过 Service Worker，
 * 它会继续拦截当前项目的 HTML / CSS / JS，导致“旧版样式”一直不消失。
 */
function clearLegacyServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  void navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => {
      if (registrations.length === 0) {
        return;
      }
      registrations.forEach((registration) => {
        void registration.unregister();
      });
      if ('caches' in window) {
        void caches
          .keys()
          .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
          .catch(() => undefined);
      }
      // 旧 SW 已经接管当前页面时，刷新一次才能拿到最新资源；用 sessionStorage 避免刷新循环
      if (navigator.serviceWorker.controller && !sessionStorage.getItem(SW_CLEANED_KEY)) {
        sessionStorage.setItem(SW_CLEANED_KEY, '1');
        window.location.reload();
      }
    })
    .catch(() => undefined);
}

/**
 * 开发环境下让停留在旧 bundle 上的标签页自动刷新。
 *
 * 每次 dev server 启动都会生成新的构建戳，旧标签页重新获得焦点时发现戳不一致就会 reload，
 * 避免出现“主题 CSS 和背景 CSS 来自不同版本”的混搭旧界面。
 */
export function watchForStalePage(): void {
  clearLegacyServiceWorker();

  if (!import.meta.env.DEV) {
    return;
  }

  // 当前页面加载时 dev server 注入的构建戳；旧标签页里保存的还是旧戳
  const currentStamp =
    document.querySelector('meta[name="dev-build-stamp"]')?.getAttribute('content') ?? '';
  if (!currentStamp) {
    return;
  }
  let reloading = false;

  const check = async () => {
    if (reloading || document.hidden) {
      return;
    }
    try {
      const response = await fetch('/__dev_build_stamp', { cache: 'no-store' });
      if (!response.ok) {
        return;
      }
      const latestStamp = (await response.text()).trim();
      if (latestStamp && latestStamp !== currentStamp) {
        reloading = true;
        window.location.reload();
      }
    } catch {
      // dev server 正在重启，忽略本次检查
    }
  };

  window.addEventListener('focus', () => void check());
  document.addEventListener('visibilitychange', () => void check());
  window.setInterval(() => void check(), 60_000);
}
