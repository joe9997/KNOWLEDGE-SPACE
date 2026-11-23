import type { ThemeMode } from './types';

export const STAR_TRAIL_COUNT = 2300;
export const STARFIELD_BLEED = 0.08;

export function isMobileViewport(width: number): boolean {
  return width <= 900;
}

/** 桌面 240 步 / 手机 144 步，配合 12s 往返旋转 */
export function getStarSteps(mobile: boolean): number {
  return mobile ? 144 : 240;
}

export function shouldPauseStarfield(hidden: boolean, reducedMotion: boolean): boolean {
  return hidden || reducedMotion;
}

export interface RepaintEnv {
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  requestAnimationFrame: (callback: () => void) => number;
  cancelAnimationFrame: (id: number) => void;
}

/** 合并连续的 resize 事件，防抖后只在下一帧重绘一次 */
export function createRepaintScheduler(
  repaint: () => void,
  delay = 180,
  env: RepaintEnv = {
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (id) => window.cancelAnimationFrame(id),
  },
) {
  let timer: number | null = null;
  let frame: number | null = null;

  return {
    request() {
      if (timer !== null) {
        env.clearTimeout(timer);
      }
      timer = env.setTimeout(() => {
        timer = null;
        frame = env.requestAnimationFrame(() => {
          frame = null;
          repaint();
        });
      }, delay);
    },
    cancel() {
      if (timer !== null) {
        env.clearTimeout(timer);
        timer = null;
      }
      if (frame !== null) {
        env.cancelAnimationFrame(frame);
        frame = null;
      }
    },
  };
}

export interface CanvasSize {
  cssWidth: number;
  cssHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  scale: number;
}

const MAX_BACKING_DIMENSION = 2400;
const MAX_DPR = 1.5;

/** 预留 8% 边缘，限制像素密度和最大尺寸 */
export function computeStarCanvasSize(
  viewportWidth: number,
  viewportHeight: number,
  devicePixelRatio: number,
): CanvasSize {
  const cssWidth = Math.max(1, viewportWidth * (1 + STARFIELD_BLEED * 2));
  const cssHeight = Math.max(1, viewportHeight * (1 + STARFIELD_BLEED * 2));
  const dpr = Math.min(Math.max(devicePixelRatio || 1, 1), MAX_DPR);
  const scale = Math.min(dpr, MAX_BACKING_DIMENSION / Math.max(cssWidth, cssHeight));
  return {
    cssWidth,
    cssHeight,
    pixelWidth: Math.round(cssWidth * scale),
    pixelHeight: Math.round(cssHeight * scale),
    scale,
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type DrawContext = Pick<
  CanvasRenderingContext2D,
  'clearRect' | 'beginPath' | 'arc' | 'stroke' | 'strokeStyle' | 'lineWidth'
>;

/**
 * 一次性绘制环形短星轨。只在主题/尺寸变化时调用，动画交给 CSS 旋转 canvas。
 * 使用固定种子，保证同主题重绘结果一致。
 */
export function drawStarfield(
  ctx: DrawContext,
  width: number,
  height: number,
  theme: ThemeMode,
): void {
  ctx.clearRect(0, 0, width, height);

  const random = mulberry32(0x5eed1234);
  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.hypot(width, height) / 2;
  const dark = theme === 'dark';

  for (let i = 0; i < STAR_TRAIL_COUNT; i += 1) {
    const radius = 18 + Math.pow(random(), 0.72) * maxRadius * 0.98;
    const angle = random() * Math.PI * 2;
    const length = 0.012 + random() * 0.16;
    const bright = random() > 0.965;
    const alpha = bright ? 0.66 + random() * 0.28 : 0.1 + random() * (dark ? 0.42 : 0.34);

    if (bright) {
      ctx.strokeStyle = dark
        ? `rgba(226, 240, 255, ${alpha})`
        : `rgba(36, 64, 104, ${alpha})`;
      ctx.lineWidth = 1.15 + random() * 0.5;
    } else {
      const cyan = random() > 0.72;
      ctx.strokeStyle = dark
        ? cyan
          ? `rgba(154, 212, 255, ${alpha})`
          : `rgba(196, 219, 255, ${alpha})`
        : cyan
          ? `rgba(58, 98, 143, ${alpha})`
          : `rgba(74, 102, 139, ${alpha})`;
      ctx.lineWidth = 0.35 + random() * 0.65;
    }

    ctx.beginPath();
    ctx.arc(cx, cy, radius, angle, angle + length);
    ctx.stroke();
  }
}
