import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion, useMediaQuery } from '../../lib/useMediaQuery';
import {
  computeStarCanvasSize,
  createRepaintScheduler,
  drawStarfield,
  getStarSteps,
  shouldPauseStarfield,
} from '../../lib/starfield';
import { useTheme } from '../../theme/ThemeProvider';
import { Snowfall } from './Snowfall';
import './starfield.css';

export function StarfieldBackground() {
  const { theme } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [hidden, setHidden] = useState(() => document.hidden);
  const reducedMotion = usePrefersReducedMotion();
  const mobile = useMediaQuery('(max-width: 900px)');
  const paused = shouldPauseStarfield(hidden, reducedMotion);
  const steps = getStarSteps(mobile);

  // 合并窗口尺寸变化：防抖 + 单帧绘制
  useEffect(() => {
    const scheduler = createRepaintScheduler(() => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    });
    const schedule = () => scheduler.request();
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('resize', schedule);
      scheduler.cancel();
    };
  }, []);

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // 只在主题或尺寸变化时重绘；浅色主题使用山景照片，不再绘制星轨
  useEffect(() => {
    if (theme === 'light') {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const size = computeStarCanvasSize(viewport.width, viewport.height, window.devicePixelRatio);
    canvas.width = size.pixelWidth;
    canvas.height = size.pixelHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    context.setTransform(size.scale, 0, 0, size.scale, 0, 0);
    drawStarfield(context, size.cssWidth, size.cssHeight, theme);
  }, [theme, viewport.width, viewport.height]);

  return (
    <div
      className="starfield"
      data-paused={paused ? 'true' : 'false'}
      data-steps={steps}
      aria-hidden="true"
    >
      <div
        className="starfield__rotator"
        style={{
          animationDuration: theme === 'dark' ? '6s' : '12s',
          animationTimingFunction: `steps(${steps}, end)`,
        }}
      >
        <canvas ref={canvasRef} className="starfield__canvas" data-testid="starfield-canvas" />
      </div>
      <div className="starfield__veil" />
      <div className="starfield__bokeh" />
      {theme === 'light' && (
        <Snowfall paused={paused} width={viewport.width} height={viewport.height} />
      )}
      <div className="starfield__grain" />
    </div>
  );
}
