import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { DAY_MS, isDue } from '../../lib/review';
import type { KnowledgeDoc, KnowledgeNode, Mastery } from '../../lib/types';
import { buildGraphLinks, computeSphereLayout } from './graphLayout';

export interface GalaxyGraphHandle {
  zoomBy: (delta: number) => void;
  reset: () => void;
}

interface GalaxyGraphProps {
  doc: KnowledgeDoc;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onZoomChange: (percent: number) => void;
  /** 演示时间偏移（天）。图谱的「到期」判断要和首页「今日待复习」用同一个“现在” */
  offsetDays: number;
}

interface ProjectedNode {
  id: string;
  sx: number;
  sy: number;
  depth: number;
  radius: number;
  node: KnowledgeNode;
}

interface NodePalette {
  core: string;
  mid: string;
  halo: string;
}

const DEFAULT_THETA = 0.42;
const DEFAULT_PHI = 0.16;
const WORLD_RADIUS = 210;
const FOV = 900;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.6;
const FONT_STACK = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

/**
 * 颜色只表达「掌握度」，与是否到期无关：
 * 0 没记住 = 玫红，1 有点模糊 = 暖黄，2 已掌握 = 薄荷绿。
 * 到期由 drawNode 里的脉冲描边单独提示，不覆盖掌握度颜色。
 */
const PALETTES: Record<Mastery, { dark: NodePalette; light: NodePalette }> = {
  0: {
    dark: { core: '#FF5C93', mid: '#FF9CC7', halo: '255, 92, 147' },
    light: { core: '#D9467A', mid: '#F07CA6', halo: '217, 70, 122' },
  },
  1: {
    dark: { core: '#F4B740', mid: '#FFD98A', halo: '244, 183, 64' },
    light: { core: '#B9801C', mid: '#E0A93F', halo: '185, 128, 28' },
  },
  2: {
    dark: { core: '#38D6AC', mid: '#8CE9C4', halo: '56, 214, 172' },
    light: { core: '#2A9371', mid: '#5FC6A4', halo: '42, 147, 113' },
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const GalaxyGraph = forwardRef<GalaxyGraphHandle, GalaxyGraphProps>(
  function GalaxyGraph({ doc, selectedId, onSelect, onZoomChange, offsetDays }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'dark');
    const selectedIdRef = useRef(selectedId);
    const onSelectRef = useRef(onSelect);
    const onZoomChangeRef = useRef(onZoomChange);
    const zoomByRef = useRef<(delta: number) => void>(() => {});
    const resetRef = useRef<() => void>(() => {});
    const rippleRef = useRef<{ id: string; start: number } | null>(null);

    useEffect(() => {
      onSelectRef.current = onSelect;
      onZoomChangeRef.current = onZoomChange;
    }, [onSelect, onZoomChange]);

    useEffect(() => {
      selectedIdRef.current = selectedId;
      rippleRef.current = selectedId ? { id: selectedId, start: performance.now() } : null;
    }, [selectedId]);

    useImperativeHandle(ref, () => ({
      zoomBy: (delta: number) => zoomByRef.current(delta),
      reset: () => resetRef.current(),
    }));

    useEffect(() => {
      const observer = new MutationObserver(() => {
        setTheme(document.documentElement.dataset.theme ?? 'dark');
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
      return () => observer.disconnect();
    }, []);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const light = theme === 'light';
      const canvas = document.createElement('canvas');
      canvas.className = 'galaxy-canvas';
      container.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return;
      }

      const layout = computeSphereLayout(doc.nodes);
      const links = buildGraphLinks(doc.nodes, doc.relations);

      // 掌握度颜色与时间无关，建一次即可；到期集合会随时间变化，定期刷新
      const palettes = new Map<string, NodePalette>(
        doc.nodes.map((node) => [node.id, PALETTES[node.mastery][light ? 'light' : 'dark']]),
      );
      let dueIds = new Set<string>();
      const refreshDue = () => {
        const now = Date.now() + offsetDays * DAY_MS;
        dueIds = new Set(
          doc.nodes.filter((node) => isDue(node.nextReviewAt, now)).map((node) => node.id),
        );
      };
      refreshDue();

      // 到期描边用 CSS 变量，深浅主题各有一套，改主题时 effect 会重建
      const ringColor =
        getComputedStyle(document.documentElement).getPropertyValue('--node-ring').trim() ||
        (light ? '#C9184A' : '#FF4D6D');

      let width = 0;
      let height = 0;
      let dpr = 1;
      let theta = DEFAULT_THETA;
      let phi = DEFAULT_PHI;
      let zoom = 1;
      let raf = 0;
      let projected: ProjectedNode[] = [];
      let hoveredId: string | null = null;
      let lastStatusAt = 0;
      let drag: { x: number; y: number; moved: boolean; pointerId: number } | null = null;

      const resize = () => {
        const rect = container.getBoundingClientRect();
        width = Math.max(1, rect.width);
        height = Math.max(1, rect.height);
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      };

      const observer = new ResizeObserver(resize);
      observer.observe(container);
      resize();

      const project = (point: { x: number; y: number; z: number }, fit: number) => {
        const cosY = Math.cos(theta);
        const sinY = Math.sin(theta);
        const x1 = point.x * cosY - point.z * sinY;
        const z1 = point.z * cosY + point.x * sinY;

        const cosX = Math.cos(phi);
        const sinX = Math.sin(phi);
        const y2 = point.y * cosX - z1 * sinX;
        const depth = z1 * cosX + point.y * sinX;

        const perspective = FOV / Math.max(320, FOV + depth * WORLD_RADIUS);
        const scale = perspective * fit * zoom;
        return {
          sx: width / 2 + x1 * WORLD_RADIUS * scale,
          sy: height * 0.47 + y2 * WORLD_RADIUS * scale,
          depth,
          scale,
        };
      };

      const drawBackground = () => {
        const base = ctx.createLinearGradient(0, 0, width, height);
        if (light) {
          base.addColorStop(0, '#EAF2FF');
          base.addColorStop(0.5, '#F6F9FF');
          base.addColorStop(1, '#E3EEFF');
        } else {
          base.addColorStop(0, '#070B19');
          base.addColorStop(0.5, '#0D152C');
          base.addColorStop(1, '#121D3A');
        }
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, width, height);

        const focal = Math.max(width, height);
        const cloud = (cx: number, cy: number, radius: number, stops: Array<[number, string]>) => {
          const gradient = ctx.createRadialGradient(cx, cy, 8, cx, cy, radius);
          stops.forEach(([offset, color]) => gradient.addColorStop(offset, color));
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, width, height);
        };

        cloud(width * 0.54, height * 0.3, focal * 0.4, light
          ? [
              [0, 'rgba(255, 255, 255, 0.9)'],
              [0.5, 'rgba(255, 255, 255, 0.4)'],
              [1, 'rgba(255, 255, 255, 0)'],
            ]
          : [
              [0, 'rgba(56, 189, 248, 0.12)'],
              [0.5, 'rgba(99, 102, 241, 0.06)'],
              [1, 'rgba(7, 11, 25, 0)'],
            ]);

        cloud(width * 0.58, height * 0.68, focal * 0.3, light
          ? [
              [0, 'rgba(255, 112, 150, 0.09)'],
              [1, 'rgba(255, 112, 150, 0)'],
            ]
          : [
              [0, 'rgba(255, 71, 126, 0.12)'],
              [1, 'rgba(255, 71, 126, 0)'],
            ]);

        cloud(width * 0.26, height * 0.74, focal * 0.26, light
          ? [
              [0, 'rgba(148, 197, 255, 0.16)'],
              [1, 'rgba(148, 197, 255, 0)'],
            ]
          : [
              [0, 'rgba(88, 120, 255, 0.1)'],
              [1, 'rgba(88, 120, 255, 0)'],
            ]);
      };

      const drawEdges = (time: number, entries: Map<string, ProjectedNode>) => {
        links.forEach((link, index) => {
          const from = entries.get(link.from);
          const to = entries.get(link.to);
          if (!from || !to) {
            return;
          }
          const dx = to.sx - from.sx;
          const dy = to.sy - from.sy;
          const length = Math.hypot(dx, dy) || 1;
          const normalX = -dy / length;
          const normalY = dx / length;
          const bend = (index % 2 === 0 ? 1 : -1) * Math.min(46, length * 0.09);
          const controlX = (from.sx + to.sx) / 2 + normalX * bend;
          const controlY = (from.sy + to.sy) / 2 + normalY * bend;
          const nearness = (from.depth + to.depth) / 2 / 2 + 0.5;
          const related =
            selectedIdRef.current === link.from || selectedIdRef.current === link.to;
          const alpha = clamp(0.13 + nearness * 0.24 + (related ? 0.22 : 0), 0, 0.62);

          ctx.save();
          ctx.beginPath();
          ctx.moveTo(from.sx, from.sy);
          ctx.quadraticCurveTo(controlX, controlY, to.sx, to.sy);
          if (link.kind === 'relation') {
            ctx.setLineDash([4, 7]);
            ctx.strokeStyle = light
              ? `rgba(217, 70, 122, ${alpha * 0.9})`
              : `rgba(255, 120, 170, ${alpha * 0.9})`;
          } else {
            ctx.strokeStyle = light
              ? `rgba(70, 110, 160, ${alpha})`
              : `rgba(150, 190, 255, ${alpha})`;
          }
          ctx.lineWidth = relationWidth(link.kind);
          ctx.stroke();
          ctx.restore();

          if (link.kind === 'tree') {
            const progress = (time * 0.075 + index * 0.17) % 1;
            const inv = 1 - progress;
            const px =
              inv * inv * from.sx + 2 * inv * progress * controlX + progress * progress * to.sx;
            const py =
              inv * inv * from.sy + 2 * inv * progress * controlY + progress * progress * to.sy;
            const glow = ctx.createRadialGradient(px, py, 0, px, py, 5.5);
            glow.addColorStop(0, light ? 'rgba(255, 255, 255, 0.95)' : 'rgba(226, 240, 255, 0.95)');
            glow.addColorStop(0.4, light ? 'rgba(90, 140, 200, 0.5)' : 'rgba(150, 200, 255, 0.45)');
            glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(px, py, 5.5, 0, Math.PI * 2);
            ctx.fill();
          }
        });
      };

      const relationWidth = (kind: 'tree' | 'relation') => (kind === 'relation' ? 1.1 : 1.2);

      const drawNode = (entry: ProjectedNode, time: number) => {
        const palette = palettes.get(entry.id) ?? PALETTES[0].dark;
        const selected = selectedIdRef.current === entry.id;
        const hovered = hoveredId === entry.id;
        const active = selected || hovered;
        const nearness = entry.depth / 2 + 0.5;
        const alpha = (0.55 + nearness * 0.45) * (active ? 1 : 0.94);
        const radius = entry.radius * (selected ? 1.18 : hovered ? 1.1 : 1);
        const haloRadius = radius * (entry.node.parentId === null ? 4.4 : 3.7);
        const breath = 1 + 0.06 * Math.sin(time * 1.9 + entry.sx * 0.01);

        ctx.save();
        ctx.globalAlpha = alpha;

        if (selected && rippleRef.current?.id === entry.id) {
          const elapsed = (performance.now() - rippleRef.current.start) / 1000;
          if (elapsed < 1.2) {
            const progress = elapsed / 1.2;
            const wave = radius + progress * radius * 5;
            const ripple = ctx.createRadialGradient(entry.sx, entry.sy, wave * 0.5, entry.sx, entry.sy, wave);
            ripple.addColorStop(0, `rgba(${palette.halo}, 0)`);
            ripple.addColorStop(0.72, `rgba(${palette.halo}, ${(1 - progress) * 0.4})`);
            ripple.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = ripple;
            ctx.beginPath();
            ctx.arc(entry.sx, entry.sy, wave, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        const aura = ctx.createRadialGradient(
          entry.sx,
          entry.sy,
          radius * 0.15,
          entry.sx,
          entry.sy,
          haloRadius * breath,
        );
        aura.addColorStop(0, `rgba(${palette.halo}, ${light ? 0.52 : 0.68})`);
        aura.addColorStop(0.34, `rgba(${palette.halo}, ${light ? 0.26 : 0.34})`);
        aura.addColorStop(0.7, `rgba(${palette.halo}, ${light ? 0.08 : 0.12})`);
        aura.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = aura;
        ctx.beginPath();
        ctx.arc(entry.sx, entry.sy, haloRadius * breath, 0, Math.PI * 2);
        ctx.fill();

        if (active) {
          const pulse = (Math.sin(time * 3.4) + 1) * 0.5;
          const activeRadius = radius * (2.1 + pulse * 0.7);
          const activeHalo = ctx.createRadialGradient(
            entry.sx,
            entry.sy,
            radius * 0.5,
            entry.sx,
            entry.sy,
            activeRadius,
          );
          activeHalo.addColorStop(0, `rgba(${palette.halo}, 0.42)`);
          activeHalo.addColorStop(0.6, `rgba(${palette.halo}, ${0.14 * (1 - pulse * 0.4)})`);
          activeHalo.addColorStop(1, 'rgba(255, 255, 255, 0)');
          ctx.fillStyle = activeHalo;
          ctx.beginPath();
          ctx.arc(entry.sx, entry.sy, activeRadius, 0, Math.PI * 2);
          ctx.fill();
        }

        const coreRadius = radius * (active ? 1.7 : 1.5);
        const core = ctx.createRadialGradient(entry.sx, entry.sy, 0, entry.sx, entry.sy, coreRadius);
        core.addColorStop(0, '#FFFFFF');
        core.addColorStop(0.24, light ? '#FFF9FB' : '#FFFFFF');
        core.addColorStop(0.46, palette.core);
        core.addColorStop(0.72, palette.mid);
        core.addColorStop(0.9, `rgba(${palette.halo}, 0.36)`);
        core.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(entry.sx, entry.sy, coreRadius, 0, Math.PI * 2);
        ctx.fill();

        // 到期不改掌握度颜色，只在外圈加一圈脉冲虚线提醒
        if (dueIds.has(entry.id)) {
          const pulse = (Math.sin(time * 2.6) + 1) * 0.5;
          ctx.save();
          ctx.globalAlpha = alpha * (0.55 + pulse * 0.45);
          ctx.strokeStyle = ringColor;
          ctx.lineWidth = 1.3;
          ctx.setLineDash([2.5, 3.5]);
          ctx.beginPath();
          ctx.arc(entry.sx, entry.sy, coreRadius + 3.5 + pulse * 1.6, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }

        ctx.restore();

        const isRoot = entry.node.parentId === null;
        const fontSize = isRoot ? 17 : 12.5;
        ctx.save();
        ctx.globalAlpha = clamp(alpha + 0.08, 0, 1);
        ctx.font = `${selected || isRoot ? 600 : 500} ${fontSize}px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3.2;
        ctx.strokeStyle = light ? 'rgba(235, 242, 250, 0.82)' : 'rgba(8, 14, 28, 0.8)';
        ctx.strokeText(entry.node.title, entry.sx, entry.sy + radius + (isRoot ? 27 : 18));
        ctx.fillStyle = light
          ? isRoot || selected
            ? '#26364A'
            : '#53657D'
          : isRoot || selected
            ? '#F8FAFC'
            : '#CBD5E1';
        ctx.fillText(entry.node.title, entry.sx, entry.sy + radius + (isRoot ? 27 : 18));
        ctx.restore();
      };

      const hitTest = (x: number, y: number): string | null => {
        let best: ProjectedNode | null = null;
        for (const entry of projected) {
          const distance = Math.hypot(x - entry.sx, y - entry.sy);
          if (distance <= Math.max(18, entry.radius + 10)) {
            if (!best || entry.depth > best.depth) {
              best = entry;
            }
          }
        }
        return best?.id ?? null;
      };

      const drawFrame = (timestamp: number) => {
        const time = timestamp / 1000;
        // 每 2 秒重算一次到期集合：页面跨天、演示时间变化都能跟上
        if (timestamp - lastStatusAt > 2000) {
          refreshDue();
          lastStatusAt = timestamp;
        }
        const fit = Math.min(width, height) / 520;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        drawBackground();

        const entries = doc.nodes.map((node) => {
          const point = layout[node.id] ?? { x: 0, y: 0, z: 0 };
          const projection = project(point, fit);
          const base = node.parentId === null ? 16 : 10.5;
          return {
            id: node.id,
            node,
            sx: projection.sx,
            sy: projection.sy,
            depth: projection.depth,
            radius: base * projection.scale * (fit < 0.9 ? 0.9 : 1),
          } as ProjectedNode;
        });
        projected = entries;
        const byId = new Map(entries.map((entry) => [entry.id, entry]));

        drawEdges(time, byId);

        const ordered = [...entries].sort((a, b) => a.depth - b.depth);
        for (const entry of ordered) {
          drawNode(entry, time);
        }

        raf = requestAnimationFrame(drawFrame);
      };

      zoomByRef.current = (delta) => {
        zoom = clamp(zoom + delta, MIN_ZOOM, MAX_ZOOM);
        onZoomChangeRef.current(Math.round(zoom * 100));
      };
      resetRef.current = () => {
        theta = DEFAULT_THETA;
        phi = DEFAULT_PHI;
        zoom = 1;
        onZoomChangeRef.current(100);
      };
      onZoomChangeRef.current(100);

      const onPointerDown = (event: PointerEvent) => {
        drag = { x: event.clientX, y: event.clientY, moved: false, pointerId: event.pointerId };
        container.setPointerCapture(event.pointerId);
        container.classList.add('is-dragging');
      };

      const onPointerMove = (event: PointerEvent) => {
        if (drag && drag.pointerId === event.pointerId) {
          const dx = event.clientX - drag.x;
          const dy = event.clientY - drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) {
            drag.moved = true;
          }
          theta += dx * 0.0075;
          phi = clamp(phi + dy * 0.0055, -1.15, 1.15);
          drag.x = event.clientX;
          drag.y = event.clientY;
          return;
        }
        const rect = container.getBoundingClientRect();
        hoveredId = hitTest(event.clientX - rect.left, event.clientY - rect.top);
        container.style.cursor = hoveredId ? 'pointer' : 'grab';
      };

      const onPointerUp = (event: PointerEvent) => {
        if (!drag || drag.pointerId !== event.pointerId) {
          return;
        }
        const rect = container.getBoundingClientRect();
        if (!drag.moved) {
          const id = hitTest(event.clientX - rect.left, event.clientY - rect.top);
          if (id) {
            onSelectRef.current(id);
          }
        }
        drag = null;
        container.classList.remove('is-dragging');
      };

      const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        zoom = clamp(zoom * (event.deltaY > 0 ? 0.92 : 1.08), MIN_ZOOM, MAX_ZOOM);
        onZoomChangeRef.current(Math.round(zoom * 100));
      };

      container.addEventListener('pointerdown', onPointerDown);
      container.addEventListener('pointermove', onPointerMove);
      container.addEventListener('pointerup', onPointerUp);
      container.addEventListener('pointercancel', onPointerUp);
      container.addEventListener('wheel', onWheel, { passive: false });

      raf = requestAnimationFrame(drawFrame);

      return () => {
        cancelAnimationFrame(raf);
        observer.disconnect();
        container.removeEventListener('pointerdown', onPointerDown);
        container.removeEventListener('pointermove', onPointerMove);
        container.removeEventListener('pointerup', onPointerUp);
        container.removeEventListener('pointercancel', onPointerUp);
        container.removeEventListener('wheel', onWheel);
        container.classList.remove('is-dragging');
        container.style.cursor = '';
        if (canvas.parentElement === container) {
          container.removeChild(canvas);
        }
      };
    }, [doc, theme, offsetDays]);

    return (
      <div
        className="galaxy-canvas-shell"
        ref={containerRef}
        data-testid="graph-canvas"
        role="img"
        aria-label="知识星系，拖动旋转、滚轮缩放，点击星点查看内容"
      />
    );
  },
);
