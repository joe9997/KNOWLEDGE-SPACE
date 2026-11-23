import { useEffect, useRef } from 'react';

interface Snowflake {
  x: number;
  y: number;
  radius: number;
  speed: number;
  drift: number;
  phase: number;
  sway: number;
  swaySpeed: number;
  alpha: number;
  age: number;
}

interface SnowfallProps {
  paused: boolean;
  width: number;
  height: number;
}

const MAX_FLAKES = 150;
const MAX_BACKING_DIMENSION = 2200;
const MAX_DPR = 1.5;

function createFlake(width: number, height: number, initial: boolean): Snowflake {
  const radius = 0.9 + Math.random() * 2.4;
  return {
    x: Math.random() * width,
    y: initial ? Math.random() * height : -12 - Math.random() * 60,
    radius,
    speed: 11 + Math.random() * 18 + radius * 4,
    drift: -5 + Math.random() * 10,
    phase: Math.random() * Math.PI * 2,
    sway: 4 + Math.random() * 9,
    swaySpeed: 0.4 + Math.random() * 0.7,
    alpha: 0.5 + Math.random() * 0.45,
    age: Math.random() * 10,
  };
}

function drawFrame(
  context: CanvasRenderingContext2D,
  flakes: Snowflake[],
  width: number,
  height: number,
) {
  context.clearRect(0, 0, width, height);

  // 用两层半透明圆模拟柔边雪花，避免逐帧 shadowBlur 的高开销
  for (const flake of flakes) {
    if (flake.radius > 1.9) {
      context.fillStyle = `rgba(236, 245, 255, ${flake.alpha * 0.16})`;
      context.beginPath();
      context.arc(flake.x, flake.y, flake.radius * 2.1, 0, Math.PI * 2);
      context.fill();
    }
    context.fillStyle = `rgba(255, 255, 255, ${flake.alpha})`;
    context.beginPath();
    context.arc(flake.x, flake.y, flake.radius, 0, Math.PI * 2);
    context.fill();
  }
}

/** 日间飘雪：只在浅色主题挂载，页面隐藏 / 减少动态效果时停止 */
export function Snowfall({ paused, width, height }: SnowfallProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flakesRef = useRef<Snowflake[]>([]);
  const frameRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) {
      return;
    }
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    const scale = Math.min(MAX_DPR, MAX_BACKING_DIMENSION / Math.max(width, height));
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);

    const target = Math.round(Math.min(MAX_FLAKES, Math.max(50, width / 9)));
    const flakes = flakesRef.current;
    while (flakes.length < target) {
      flakes.push(createFlake(width, height, true));
    }
    flakes.length = target;
    flakes.forEach((flake) => {
      flake.x = Math.min(Math.max(flake.x, -10), width + 10);
      flake.y = Math.min(Math.max(flake.y, -20), height + 20);
    });

    drawFrame(context, flakes, width, height);
    if (paused) {
      return;
    }

    let last = performance.now();
    const tick = (now: number) => {
      const delta = Math.min(48, now - last) / 1000;
      last = now;
      for (const flake of flakes) {
        flake.age += delta;
        flake.y += flake.speed * delta;
        flake.x +=
          (flake.drift + Math.sin(flake.phase + flake.age * flake.swaySpeed) * flake.sway) *
          delta;
        if (flake.y > height + 12) {
          flake.y = -12;
          flake.x = Math.random() * width;
        }
        if (flake.x < -14) {
          flake.x = width + 14;
        } else if (flake.x > width + 14) {
          flake.x = -14;
        }
      }
      drawFrame(context, flakes, width, height);
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frameRef.current);
  }, [width, height, paused]);

  return <canvas ref={canvasRef} className="starfield__snow" data-testid="snowfall-canvas" />;
}
