import { describe, expect, it } from 'vitest';
import {
  computeStarCanvasSize,
  createRepaintScheduler,
  drawStarfield,
  getStarSteps,
  shouldPauseStarfield,
  STAR_TRAIL_COUNT,
} from '../starfield';
import type { RepaintEnv } from '../starfield';

function createFakeContext() {
  const arcs: Array<{ x: number; y: number; start: number; end: number }> = [];
  const colors: string[] = [];
  const context = {
    strokeStyle: '' as string | CanvasGradient | CanvasPattern,
    lineWidth: 0,
    clearRect: () => undefined,
    beginPath: () => undefined,
    arc: (x: number, y: number, _radius: number, start: number, end: number) => {
      arcs.push({ x, y, start, end });
    },
    stroke: () => {
      if (typeof context.strokeStyle === 'string') {
        colors.push(context.strokeStyle);
      }
    },
  };
  return { context, arcs, colors };
}

describe('星轨动画参数', () => {
  it('桌面 240 步、手机 144 步', () => {
    expect(getStarSteps(false)).toBe(240);
    expect(getStarSteps(true)).toBe(144);
  });

  it('页面隐藏或减少动态效果时暂停', () => {
    expect(shouldPauseStarfield(true, false)).toBe(true);
    expect(shouldPauseStarfield(false, true)).toBe(true);
    expect(shouldPauseStarfield(false, false)).toBe(false);
  });

  it('画布预留约 8% 边缘、限制 DPR 与最大尺寸', () => {
    const normal = computeStarCanvasSize(1000, 800, 2);
    expect(normal.cssWidth).toBeCloseTo(1160);
    expect(normal.cssHeight).toBeCloseTo(928);
    expect(normal.scale).toBe(1.5);

    const huge = computeStarCanvasSize(4000, 3000, 3);
    expect(Math.max(huge.pixelWidth, huge.pixelHeight)).toBeLessThanOrEqual(2400);
  });
});

describe('星轨绘制调度', () => {
  function createFakeEnv() {
    let nextId = 1;
    const timers = new Map<number, () => void>();
    const frames = new Map<number, () => void>();
    const env: RepaintEnv = {
      setTimeout: (callback) => {
        const id = nextId++;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id);
      },
      requestAnimationFrame: (callback) => {
        const id = nextId++;
        frames.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id) => {
        frames.delete(id);
      },
    };
    const flush = () => {
      const pendingTimers = [...timers.values()];
      timers.clear();
      pendingTimers.forEach((callback) => callback());
      const pendingFrames = [...frames.values()];
      frames.clear();
      pendingFrames.forEach((callback) => callback());
    };
    return { env, flush, pending: () => timers.size + frames.size };
  }

  it('连续 resize 被合并为一次重绘', () => {
    const { env, flush, pending } = createFakeEnv();
    let paints = 0;
    const scheduler = createRepaintScheduler(() => {
      paints += 1;
    }, 180, env);
    scheduler.request();
    scheduler.request();
    scheduler.request();
    expect(pending()).toBe(1);
    flush();
    expect(paints).toBe(1);
  });

  it('cancel 后不会重绘', () => {
    const { env, flush, pending } = createFakeEnv();
    let paints = 0;
    const scheduler = createRepaintScheduler(() => {
      paints += 1;
    }, 180, env);
    scheduler.request();
    scheduler.cancel();
    expect(pending()).toBe(0);
    flush();
    expect(paints).toBe(0);
  });
});

describe('星轨绘制', () => {
  it('一次绘制 2300 条短星轨', () => {
    const { context, arcs } = createFakeContext();
    drawStarfield(context, 1000, 800, 'dark');
    expect(arcs).toHaveLength(STAR_TRAIL_COUNT);
    arcs.forEach((arc) => {
      expect(arc.x).toBe(500);
      expect(arc.y).toBe(400);
      expect(arc.end).toBeGreaterThan(arc.start);
    });
  });

  it('相同种子下重绘结果一致（主题/尺寸变化时才需要重绘）', () => {
    const first = createFakeContext();
    const second = createFakeContext();
    drawStarfield(first.context, 1000, 800, 'dark');
    drawStarfield(second.context, 1000, 800, 'dark');
    expect(second.arcs).toEqual(first.arcs);
    expect(second.colors).toEqual(first.colors);
  });

  it('浅色主题使用独立的深蓝灰星轨，并且保持可见对比度', () => {
    const dark = createFakeContext();
    const light = createFakeContext();
    drawStarfield(dark.context, 1000, 800, 'dark');
    drawStarfield(light.context, 1000, 800, 'light');
    expect(light.colors[0]).not.toBe(dark.colors[0]);

    const alphas = light.colors.map((color) => {
      const match = color.match(/rgba\([^)]*,\s*([0-9.]+)\)/);
      return match ? Number(match[1]) : 1;
    });
    expect(Math.min(...alphas)).toBeGreaterThanOrEqual(0.1);
    expect(Math.max(...alphas)).toBeGreaterThan(0.4);
  });
});
