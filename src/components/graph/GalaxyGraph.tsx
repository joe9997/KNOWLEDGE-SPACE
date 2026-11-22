import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { DAY_MS, isDue } from '../../lib/review';
import type { KnowledgeDoc, KnowledgeNode, Mastery } from '../../lib/types';
import type { GraphLink, GraphView, SpherePoint } from './graphLayout';
import { buildGraphLinks, computeGraphLayout, hash01 } from './graphLayout';
import { paletteVariant } from '../../lib/learningPrefs';
import type { PaletteTheme } from '../../lib/learningPrefs';

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
  view: GraphView;
  /** 用户选择的星球配色方案 */
  paletteTheme: PaletteTheme;
}

interface ProjectedNode {
  id: string;
  sx: number;
  sy: number;
  depth: number;
  radius: number;
  /** 每颗星固定的闪烁相位，避免所有节点同步呼吸 */
  phase: number;
  /** 重要性 0–1：由层级、子节点数、关联数综合而来，决定星球大小 */
  weight: number;
  /** 开屏进度 0–1：0 时星点还聚合在中心，1 时完全展开 */
  appear: number;
  node: KnowledgeNode;
}

export interface NodePalette {
  core: string;
  mid: string;
  halo: string;
}

const DEFAULT_THETA = 0.42;
/** 倾斜角：把盘面压成约 1:0.55 的椭圆，像从斜上方俯视一个旋涡星系 */
const DEFAULT_PHI = 0.55;
const TWO_PI = Math.PI * 2;
const WORLD_RADIUS = 230;
const FOV = 900;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.6;
const FONT_STACK = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

/** 开屏缓动：先快后缓，末端轻微过冲，像孔雀尾羽抖开到位 */
function easeOutBack(t: number): number {
  const c1 = 0.9;
  const c3 = c1 + 1;
  const p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}

/** 按画布宽度截断文本，避免文件名在中心节点下方溢出 */
function fitCanvasLabel(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }
  let end = text.length;
  while (end > 1 && ctx.measureText(`${text.slice(0, end)}…`).width > maxWidth) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

/**
 * 颜色只表达「掌握度」，与是否到期无关：
 * 0 没记住 / 1 有点模糊 / 2 已掌握。
 * 具体色相由用户选择的配色方案决定，同一掌握度下仍保留三档星光，
 * 按节点 id 稳定分配，让星系有层次但不破坏图例语义。
 * 到期由 drawNode 里的脉冲描边单独提示，不覆盖掌握度颜色。
 */
function buildPalettes(theme: PaletteTheme, light: boolean): Record<Mastery, NodePalette[]> {
  const variants = [0, 1, 2];
  return {
    0: variants.map((index) => paletteVariant(theme, 0, light, index)),
    1: variants.map((index) => paletteVariant(theme, 1, light, index)),
    2: variants.map((index) => paletteVariant(theme, 2, light, index)),
  };
}

function resolvePalette(
  node: KnowledgeNode,
  table: Record<Mastery, NodePalette[]>,
): NodePalette {
  const variants = table[node.mastery];
  const index = Math.min(
    variants.length - 1,
    Math.floor(hash01(`${node.id}:${node.mastery}`) * variants.length),
  );
  return variants[index];
}

/**
 * 知识点重要性：挂的子节点越多、与其他概念关联越多、越靠近中心大纲层级，星体越大。
 * 与掌握度无关，复习不会改变大小，避免星球忽大忽小。
 */
function computeImportance(doc: KnowledgeDoc): Map<string, number> {
  const ids = new Set(doc.nodes.map((node) => node.id));
  const children = new Map<string, number>();
  doc.nodes.forEach((node) => {
    if (node.parentId && ids.has(node.parentId)) {
      children.set(node.parentId, (children.get(node.parentId) ?? 0) + 1);
    }
  });
  const degrees = new Map<string, number>();
  doc.relations.forEach((relation) => {
    if (!ids.has(relation.from) || !ids.has(relation.to)) {
      return;
    }
    degrees.set(relation.from, (degrees.get(relation.from) ?? 0) + 1);
    degrees.set(relation.to, (degrees.get(relation.to) ?? 0) + 1);
  });
  const parentOf = new Map(doc.nodes.map((node) => [node.id, node.parentId]));

  const scores = doc.nodes.map((node) => {
    let depth = 0;
    let cursor = parentOf.get(node.id) ?? null;
    while (cursor && depth < 8) {
      depth += 1;
      cursor = parentOf.get(cursor) ?? null;
    }
    const levelBonus = node.level === 0 ? 1.6 : node.level === 1 ? 0.6 : 0;
    return (
      1 +
      (children.get(node.id) ?? 0) * 1.8 +
      (degrees.get(node.id) ?? 0) * 0.9 +
      Math.max(0, 3 - depth) * 0.9 +
      levelBonus
    );
  });
  const max = Math.max(1, ...scores);
  return new Map(doc.nodes.map((node, index) => [node.id, Math.min(1, scores[index] / max)]));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function colorChannels(color: string): [number, number, number] {
  if (color.startsWith('#')) {
    return [
      Number.parseInt(color.slice(1, 3), 16),
      Number.parseInt(color.slice(3, 5), 16),
      Number.parseInt(color.slice(5, 7), 16),
    ];
  }
  const channels = color.split(',').map((channel) => Number.parseFloat(channel.trim()));
  return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0];
}

function mixChannel(from: number, to: number, t: number): number {
  return Math.round(from + (to - from) * clamp(t, 0, 1));
}

/** 评级后的星体与光晕共用同一组插值颜色，避免只变中心、光晕仍停留在旧色 */
export function mixPalettes(from: NodePalette, to: NodePalette, progress: number): NodePalette {
  const t = 1 - Math.pow(1 - clamp(progress, 0, 1), 3);
  const coreFrom = colorChannels(from.core);
  const coreTo = colorChannels(to.core);
  const midFrom = colorChannels(from.mid);
  const midTo = colorChannels(to.mid);
  const haloFrom = colorChannels(from.halo);
  const haloTo = colorChannels(to.halo);
  const hex = (channels: [number, number, number], target: [number, number, number]) =>
    `#${channels.map((channel, index) => mixChannel(channel, target[index], t).toString(16).padStart(2, '0')).join('')}`;
  return {
    core: hex(coreFrom, coreTo),
    mid: hex(midFrom, midTo),
    halo: haloFrom.map((channel, index) => mixChannel(channel, haloTo[index], t)).join(', '),
  };
}

function samePalette(a: NodePalette | undefined, b: NodePalette): boolean {
  return Boolean(a && a.core === b.core && a.mid === b.mid && a.halo === b.halo);
}

export const GalaxyGraph = forwardRef<GalaxyGraphHandle, GalaxyGraphProps>(
  function GalaxyGraph({ doc, selectedId, onSelect, onZoomChange, offsetDays, view, paletteTheme }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'dark');
    const selectedIdRef = useRef(selectedId);
    const onSelectRef = useRef(onSelect);
    const onZoomChangeRef = useRef(onZoomChange);
    const zoomByRef = useRef<(delta: number) => void>(() => {});
    const resetRef = useRef<() => void>(() => {});
    const rippleRef = useRef<{ id: string; start: number } | null>(null);
    const docRef = useRef(doc);
    const offsetDaysRef = useRef(offsetDays);
    const syncSceneRef = useRef<() => void>(() => {});

    useEffect(() => {
      onSelectRef.current = onSelect;
      onZoomChangeRef.current = onZoomChange;
    }, [onSelect, onZoomChange]);

    // 复习评级后 doc 会换成新对象：只同步颜色 / 布局 / 到期集合，不重建画布
    useEffect(() => {
      docRef.current = doc;
      syncSceneRef.current();
    }, [doc]);

    useEffect(() => {
      offsetDaysRef.current = offsetDays;
    }, [offsetDays]);

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
      const paletteTable = buildPalettes(paletteTheme, light);
      const canvas = document.createElement('canvas');
      canvas.className = 'galaxy-canvas';
      container.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return;
      }

      let layout: Record<string, SpherePoint> = {};
      let links: GraphLink[] = [];
      let palettes = new Map<string, NodePalette>();
      let targetPalettes = new Map<string, NodePalette>();
      const paletteTransitions = new Map<
        string,
        { from: NodePalette; to: NodePalette; start: number | null }
      >();
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      let importance = new Map<string, number>();
      let dueIds = new Set<string>();

      const refreshDue = () => {
        const now = Date.now() + offsetDaysRef.current * DAY_MS;
        dueIds = new Set(
          docRef.current.nodes
            .filter((node) => isDue(node.nextReviewAt, now))
            .map((node) => node.id),
        );
      };

      // 布局与到期集合原地更新；掌握度颜色从当前显示色平滑过渡到目标色
      const syncScene = () => {
        const current = docRef.current;
        layout = computeGraphLayout(current, view);
        links = buildGraphLinks(current.nodes, current.relations);
        const nextTargets = new Map(
          current.nodes.map((node) => [node.id, resolvePalette(node, paletteTable)]),
        );
        current.nodes.forEach((node) => {
          const target = nextTargets.get(node.id)!;
          const previousTarget = targetPalettes.get(node.id);
          const displayed = palettes.get(node.id);
          if (samePalette(previousTarget, target)) {
            return;
          }
          if (!displayed || reducedMotion) {
            palettes.set(node.id, target);
            paletteTransitions.delete(node.id);
            return;
          }
          // 弹窗期间先记录目标色，关闭后再启动，保证用户能看到完整「开灯」过程
          paletteTransitions.set(node.id, { from: displayed, to: target, start: null });
        });
        const ids = new Set(current.nodes.map((node) => node.id));
        for (const id of palettes.keys()) {
          if (!ids.has(id)) {
            palettes.delete(id);
            paletteTransitions.delete(id);
          }
        }
        targetPalettes = nextTargets;
        importance = computeImportance(current);
        refreshDue();
      };
      syncSceneRef.current = syncScene;
      syncScene();

      // 到期描边用 CSS 变量，深浅主题各有一套，改主题时 effect 会重建
      const ringColor =
        getComputedStyle(document.documentElement).getPropertyValue('--node-ring').trim() ||
        (light ? '#C9184A' : '#FF4D6D');

      let width = 0;
      let height = 0;
      let dpr = 1;
      let theta = view === 'galaxy' ? DEFAULT_THETA : 0;
      let phi = view === 'galaxy' ? DEFAULT_PHI : 0;
      let panX = 0;
      let panY = 0;
      let zoom = 1;
      let raf = 0;
      let projected: ProjectedNode[] = [];
      let hoveredId: string | null = null;
      let lastStatusAt = 0;
      // 进入页面后从中心单点「开屏」，时间戳在第一帧确定
      let bloomAt: number | null = null;
      let drag: { x: number; y: number; moved: boolean; pointerId: number } | null = null;
      // 鼠标视差：背景星空缓慢跟随指针，营造「身处宇宙」的纵深感（节点不移动，不影响阅读）
      const pointer = { x: 0, y: 0 };
      const parallax = { x: 0, y: 0 };

      // 静态星空预渲染到离屏画布：拖动、缩放时直接贴图，不逐帧重算几千个点
      const dust = document.createElement('canvas');
      const dustCtx = dust.getContext('2d');
      // 少量亮星单独做闪烁，避免整张星空逐帧重绘
      let twinkles: Array<{ x: number; y: number; r: number; phase: number; speed: number }> = [];
      // 星空画布是视口的 1.1 倍对角线正方形，绕星系中心旋转时四角不会露白
      let dustSize = 0;

      const renderDust = () => {
        if (!dustCtx) {
          return;
        }
        dustSize = Math.ceil(Math.hypot(width, height) * 1.1);
        dust.width = Math.floor(dustSize * dpr);
        dust.height = Math.floor(dustSize * dpr);
        dustCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        dustCtx.clearRect(0, 0, dustSize, dustSize);
        twinkles = [];
        const half = dustSize / 2;

        if (light) {
          // 浅色主题：只在星系盘附近保留一点点淡蓝星尘
          const discRadius = dustSize * 0.36;
          const count = Math.min(650, Math.round((dustSize * dustSize) / 4200));
          for (let index = 0; index < count; index += 1) {
            const angle = hash01(`dust-a-${index}`) * TWO_PI;
            const spread = Math.sqrt(hash01(`dust-r-${index}`)) * discRadius;
            const x = Math.cos(angle) * spread;
            const y = Math.sin(angle) * spread * 0.46;
            if (Math.abs(x) > half + 8 || Math.abs(y) > half + 8) {
              continue;
            }
            const size = 0.35 + hash01(`dust-s-${index}`) * 1.05;
            const alpha = 0.08 + hash01(`dust-o-${index}`) * 0.5;
            dustCtx.fillStyle = `rgba(74, 110, 158, ${alpha * 0.4})`;
            dustCtx.beginPath();
            dustCtx.arc(x, y, size, 0, TWO_PI);
            dustCtx.fill();
          }
          return;
        }

        // 深色主题：整片宇宙星空，大小、亮度、冷暖都拉开层次
        // 约四分之一的星聚在一条倾斜的银河带上，看起来像「身处银河系内部」
        const bandAngle = -0.44;
        const cosA = Math.cos(bandAngle);
        const sinA = Math.sin(bandAngle);
        const extent = Math.max(width, height);
        const count = Math.min(1600, Math.round((dustSize * dustSize) / 2400));
        for (let index = 0; index < count; index += 1) {
          let x: number;
          let y: number;
          const inBand = index % 4 === 0;
          if (inBand) {
            const along = (hash01(`band-a-${index}`) - 0.5) * 1.7 * extent;
            const across = (hash01(`band-b-${index}`) - 0.5) * 0.34 * extent;
            x = along * cosA - across * sinA;
            y = along * sinA + across * cosA;
            if (Math.abs(x) > half || Math.abs(y) > half) {
              continue;
            }
          } else {
            x = (hash01(`star-x-${index}`) - 0.5) * dustSize;
            y = (hash01(`star-y-${index}`) - 0.5) * dustSize;
          }
          const roll = hash01(`star-k-${index}`);
          const size =
            (0.3 + Math.pow(hash01(`star-s-${index}`), 2.2) * 1.5) * (inBand ? 0.8 : 1);
          const alpha =
            (0.12 + Math.pow(hash01(`star-o-${index}`), 1.6) * 0.75) * (inBand ? 0.8 : 1);
          dustCtx.fillStyle =
            roll > 0.94
              ? `rgba(255, 220, 190, ${alpha * 0.9})`
              : roll > 0.86
                ? `rgba(190, 210, 255, ${alpha})`
                : `rgba(226, 238, 255, ${alpha})`;
          dustCtx.beginPath();
          dustCtx.arc(x, y, size, 0, TWO_PI);
          dustCtx.fill();

          if (index % 17 === 0 && size > 1) {
            twinkles.push({
              x,
              y,
              r: size * (0.9 + hash01(`star-t-${index}`) * 0.8),
              phase: hash01(`star-p-${index}`) * TWO_PI,
              speed: 1.2 + hash01(`star-v-${index}`) * 1.8,
            });
          }
        }
      };

      const resize = () => {
        const rect = container.getBoundingClientRect();
        width = Math.max(1, rect.width);
        height = Math.max(1, rect.height);
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        renderDust();
      };

      const observer = new ResizeObserver(resize);
      observer.observe(container);
      resize();

      const project = (point: { x: number; y: number; z: number }, fit: number) => {
        if (view !== 'galaxy') {
          const scale = fit * zoom;
          return {
            sx: width / 2 + point.x * WORLD_RADIUS * scale + panX,
            sy: height * 0.47 + point.y * WORLD_RADIUS * scale + panY,
            depth: point.z,
            scale,
          };
        }
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
          sx: width / 2 + x1 * WORLD_RADIUS * scale + panX,
          sy: height * 0.47 + y2 * WORLD_RADIUS * scale + panY,
          depth,
          scale,
        };
      };

      const drawBackground = (time: number) => {
        const base = ctx.createLinearGradient(0, 0, width, height);
        if (light) {
          base.addColorStop(0, '#EAF2FF');
          base.addColorStop(0.5, '#F6F9FF');
          base.addColorStop(1, '#E3EEFF');
        } else {
          base.addColorStop(0, '#01030A');
          base.addColorStop(0.45, '#040817');
          base.addColorStop(0.75, '#070D1E');
          base.addColorStop(1, '#0A0F24');
        }
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, width, height);

        const focal = Math.max(width, height);
        // 背景层的最终位移：指针视差 + 极慢的宇宙漂移，节点坐标不参与
        const bgX = parallax.x + Math.sin(time * 0.03) * 7;
        const bgY = parallax.y + Math.cos(time * 0.024) * 5;
        const spinX = width / 2;
        const spinY = height * 0.47;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const cloud = (
          cx: number,
          cy: number,
          radius: number,
          stops: Array<[number, string]>,
          depth = 0.5,
        ) => {
          // 星云中心先绕星系中心旋转，再叠加指针视差，和思维导图保持同一转动
          const dx = cx - spinX;
          const dy = cy - spinY;
          const ox = spinX + dx * cosT - dy * sinT + bgX * depth;
          const oy = spinY + dx * sinT + dy * cosT + bgY * depth;
          const gradient = ctx.createRadialGradient(ox, oy, 8, ox, oy, radius);
          stops.forEach(([offset, color]) => gradient.addColorStop(offset, color));
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, width, height);
        };

        // 银河带：一道很淡的斜向光带，像从银河系内部仰望星野
        if (!light) {
          ctx.save();
          ctx.translate(width / 2, height / 2);
          ctx.rotate(-0.44 + theta);
          const band = ctx.createLinearGradient(0, -height * 0.3, 0, height * 0.3);
          band.addColorStop(0, 'rgba(190, 210, 255, 0)');
          band.addColorStop(0.5, 'rgba(196, 216, 255, 0.07)');
          band.addColorStop(1, 'rgba(190, 210, 255, 0)');
          ctx.fillStyle = band;
          ctx.fillRect(-width, -height, width * 2, height * 2);
          ctx.restore();
        }

        cloud(width * 0.54, height * 0.3, focal * 0.4, light
          ? [
              [0, 'rgba(255, 255, 255, 0.55)'],
              [0.5, 'rgba(255, 255, 255, 0.24)'],
              [1, 'rgba(255, 255, 255, 0)'],
            ]
          : [
              [0, 'rgba(56, 189, 248, 0.14)'],
              [0.5, 'rgba(99, 102, 241, 0.08)'],
              [1, 'rgba(4, 8, 23, 0)'],
            ]);

        cloud(width * 0.58, height * 0.68, focal * 0.3, light
          ? [
              [0, 'rgba(255, 112, 150, 0.09)'],
              [1, 'rgba(255, 112, 150, 0)'],
            ]
          : [
              [0, 'rgba(255, 71, 126, 0.1)'],
              [1, 'rgba(255, 71, 126, 0)'],
            ]);

        cloud(width * 0.26, height * 0.74, focal * 0.26, light
          ? [
              [0, 'rgba(148, 197, 255, 0.16)'],
              [1, 'rgba(148, 197, 255, 0)'],
            ]
          : [
              [0, 'rgba(124, 92, 255, 0.13)'],
              [0.55, 'rgba(88, 120, 255, 0.06)'],
              [1, 'rgba(88, 120, 255, 0)'],
            ]);

        // 深色主题：再叠两团暗星云，让太空有纵深
        if (!light) {
          cloud(width * 0.78, height * 0.22, focal * 0.24, [
            [0, 'rgba(45, 212, 191, 0.1)'],
            [1, 'rgba(45, 212, 191, 0)'],
          ]);
          cloud(width * 0.16, height * 0.18, focal * 0.2, [
            [0, 'rgba(255, 176, 120, 0.06)'],
            [1, 'rgba(255, 176, 120, 0)'],
          ]);
        }

        // 星系级光晕：很大一圈极淡的暖光，制造尺度感，透明度压得很低不挡节点
        if (!light) {
          const glowRadius = focal * 0.62;
          const glowX = width / 2 + bgX * 0.8;
          const glowY = height * 0.47 + bgY * 0.8;
          const halo = ctx.createRadialGradient(glowX, glowY, 0, glowX, glowY, glowRadius);
          halo.addColorStop(0, 'rgba(255, 214, 160, 0.12)');
          halo.addColorStop(0.32, 'rgba(130, 150, 255, 0.06)');
          halo.addColorStop(0.7, 'rgba(90, 70, 200, 0.025)');
          halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
          ctx.fillStyle = halo;
          ctx.fillRect(0, 0, width, height);
        }

        // 浅色主题：极缓流动的柔光，让大片留白像有呼吸的雾面玻璃，而不是一块空背景
        if (light) {
          const tints = ['120, 170, 255', '255, 170, 200', '150, 230, 215'];
          for (let index = 0; index < tints.length; index += 1) {
            const phase = time * (0.05 + index * 0.017) + index * 2.1;
            const cx = width * (0.5 + Math.cos(phase) * 0.22) + bgX * 0.6;
            const cy = height * (0.46 + Math.sin(phase * 0.8) * 0.2) + bgY * 0.6;
            const radius = Math.max(width, height) * (0.3 + index * 0.07);
            const shimmer = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
            shimmer.addColorStop(0, `rgba(${tints[index]}, 0.12)`);
            shimmer.addColorStop(0.55, `rgba(${tints[index]}, 0.05)`);
            shimmer.addColorStop(1, `rgba(${tints[index]}, 0)`);
            ctx.fillStyle = shimmer;
            ctx.fillRect(0, 0, width, height);
          }
        }

        if (dustCtx && dustSize > 0) {
          // 星空与星系盘共用同一个旋转角：拖动时整片宇宙跟着思维导图一起转
          ctx.save();
          ctx.translate(width / 2 + bgX, height * 0.47 + bgY);
          ctx.rotate(theta);
          ctx.drawImage(dust, -dustSize / 2, -dustSize / 2, dustSize, dustSize);
          if (!light) {
            // 少量亮星闪烁：只画预先挑出来的几十颗，开销可忽略
            ctx.fillStyle = 'rgba(214, 232, 255, 1)';
            for (const star of twinkles) {
              const flicker = 0.5 + 0.5 * Math.sin(time * star.speed + star.phase);
              ctx.globalAlpha = 0.18 + flicker * 0.6;
              ctx.beginPath();
              ctx.arc(star.x, star.y, star.r, 0, TWO_PI);
              ctx.fill();
            }
            ctx.globalAlpha = 1;
          }
          ctx.restore();
        }
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
          const appear = Math.min(from.appear, to.appear);
          const related =
            selectedIdRef.current === link.from || selectedIdRef.current === link.to;
          const alpha = clamp(0.13 + nearness * 0.24 + (related ? 0.22 : 0), 0, 0.62) * appear;

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
            // 沿连线从家长的中性星光渐变到子节点的掌握度颜色
            const tint = palettes.get(link.to);
            const line = ctx.createLinearGradient(from.sx, from.sy, to.sx, to.sy);
            line.addColorStop(
              0,
              light
                ? `rgba(70, 110, 160, ${alpha * 0.7})`
                : `rgba(150, 190, 255, ${alpha * 0.75})`,
            );
            line.addColorStop(
              1,
              tint
                ? `rgba(${tint.halo}, ${alpha * 0.95})`
                : light
                  ? `rgba(70, 110, 160, ${alpha})`
                  : `rgba(150, 190, 255, ${alpha})`,
            );
            ctx.strokeStyle = line;
          }
          ctx.lineWidth = relationWidth(link.kind);
          ctx.stroke();
          ctx.restore();

          if (link.kind === 'tree' && appear > 0.02) {
            const progress = (time * 0.075 + index * 0.17) % 1;
            const inv = 1 - progress;
            const px =
              inv * inv * from.sx + 2 * inv * progress * controlX + progress * progress * to.sx;
            const py =
              inv * inv * from.sy + 2 * inv * progress * controlY + progress * progress * to.sy;
            ctx.save();
            ctx.globalAlpha = appear;
            const glow = ctx.createRadialGradient(px, py, 0, px, py, 5.5);
            const tint = palettes.get(link.to);
            glow.addColorStop(0, light ? 'rgba(255, 255, 255, 0.95)' : 'rgba(226, 240, 255, 0.95)');
            glow.addColorStop(
              0.4,
              tint
                ? `rgba(${tint.halo}, 0.55)`
                : light
                  ? 'rgba(90, 140, 200, 0.5)'
                  : 'rgba(150, 200, 255, 0.45)',
            );
            glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(px, py, 5.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        });
      };

      const relationWidth = (kind: 'tree' | 'relation') => (kind === 'relation' ? 1.1 : 1.2);

      /** 四芒星闪光：核心星与选中 / 悬停的星才画，保持稀有度和性能 */
      const drawFlare = (
        entry: ProjectedNode,
        palette: NodePalette,
        alpha: number,
        time: number,
      ) => {
        const active = selectedIdRef.current === entry.id || hoveredId === entry.id;
        // 中心主节点是「源点」而不是知识点，不再默认挂四芒星闪光
        if (!active) {
          return;
        }
        const length = entry.radius * (active ? 5.4 : 3.6);
        const flicker = 0.65 + 0.35 * Math.sin(time * 2.3 + entry.phase);
        ctx.save();
        ctx.globalAlpha = alpha * flicker * (active ? 0.7 : 0.38);
        ctx.lineWidth = 1;

        const horizontal = ctx.createLinearGradient(
          entry.sx - length,
          entry.sy,
          entry.sx + length,
          entry.sy,
        );
        horizontal.addColorStop(0, `rgba(${palette.halo}, 0)`);
        horizontal.addColorStop(0.5, `rgba(${palette.halo}, 0.85)`);
        horizontal.addColorStop(1, `rgba(${palette.halo}, 0)`);
        ctx.strokeStyle = horizontal;
        ctx.beginPath();
        ctx.moveTo(entry.sx - length, entry.sy);
        ctx.lineTo(entry.sx + length, entry.sy);
        ctx.stroke();

        const vertical = ctx.createLinearGradient(
          entry.sx,
          entry.sy - length,
          entry.sx,
          entry.sy + length,
        );
        vertical.addColorStop(0, `rgba(${palette.halo}, 0)`);
        vertical.addColorStop(0.5, `rgba(${palette.halo}, 0.85)`);
        vertical.addColorStop(1, `rgba(${palette.halo}, 0)`);
        ctx.strokeStyle = vertical;
        ctx.beginPath();
        ctx.moveTo(entry.sx, entry.sy - length);
        ctx.lineTo(entry.sx, entry.sy + length);
        ctx.stroke();
        ctx.restore();
      };

      const drawNode = (entry: ProjectedNode, time: number) => {
        const isRoot = entry.node.parentId === null;
        // 中心主节点用一套独立的粉色「源点」配色，不参与掌握度配色
        const palette = isRoot
          ? {
              core: light ? '#d9a8cf' : '#e0a8d8',
              mid: light ? '#c9b2ee' : '#d8bcf5',
              halo: light ? '224, 140, 197' : '238, 159, 214',
            }
          : palettes.get(entry.id) ?? resolvePalette(entry.node, paletteTable);
        const selected = selectedIdRef.current === entry.id;
        const hovered = hoveredId === entry.id;
        const active = selected || hovered;
        const nearness = entry.depth / 2 + 0.5;
        const alpha = (0.55 + nearness * 0.45) * (active ? 1 : 0.94);
        const radius = entry.radius * (selected ? 1.18 : hovered ? 1.1 : 1);
        const haloRadius = radius * 3.7;
        // 呼吸幅度略微加大，让中心星球一眼能看出在起伏
        const breath = 1 + 0.11 * Math.sin(time * 1.6 + entry.phase);

        ctx.save();
        ctx.globalAlpha = alpha * entry.appear;

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
        // 中心主节点的光晕再提亮一档，让它像参考图一样醒目
        const auraBoost = isRoot ? 1.4 : 1;
        aura.addColorStop(0, `rgba(${palette.halo}, ${Math.min(1, (light ? 0.52 : 0.68) * auraBoost)})`);
        aura.addColorStop(0.34, `rgba(${palette.halo}, ${Math.min(1, (light ? 0.26 : 0.34) * auraBoost)})`);
        aura.addColorStop(
          0.7,
          `rgba(${palette.halo}, ${Math.min(1, (light ? 0.08 : 0.12) * auraBoost)})`,
        );
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

        const coreRadius = isRoot ? radius * 0.62 : radius * (active ? 1.7 : 1.5);
        if (!isRoot) {
          const core = ctx.createRadialGradient(
            entry.sx,
            entry.sy,
            0,
            entry.sx,
            entry.sy,
            coreRadius,
          );
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
        }

        // 球体自转：高光沿球面缓慢扫过，让圆球看起来是立体的、一直在转
        if (!isRoot && coreRadius > 5.5) {
          const spin = time * (0.5 + hash01(`${entry.id}:spin`) * 0.45) + entry.phase;
          const hx = entry.sx + Math.cos(spin) * coreRadius * 0.4;
          const hy = entry.sy + Math.sin(spin) * coreRadius * 0.46;
          const shine = ctx.createRadialGradient(hx, hy, 0, hx, hy, coreRadius * 0.62);
          shine.addColorStop(0, 'rgba(255, 255, 255, 0.92)');
          shine.addColorStop(0.42, 'rgba(255, 255, 255, 0.3)');
          shine.addColorStop(1, 'rgba(255, 255, 255, 0)');
          ctx.save();
          ctx.globalAlpha = light ? 0.8 : 0.95;
          ctx.beginPath();
          ctx.arc(entry.sx, entry.sy, coreRadius * 0.94, 0, Math.PI * 2);
          ctx.clip();
          ctx.fillStyle = shine;
          ctx.beginPath();
          ctx.arc(hx, hy, coreRadius * 0.62, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // 中心「源点」：文件标题对应的特殊节点。
        // 外观参考品牌图标——实心圆点 + 外层光环 + 旋转轨道与卫星，不是知识点星核。
        if (isRoot) {
          const orbitRx = coreRadius * 2;
          const orbitRy = coreRadius * 1.16;
          ctx.save();
          ctx.translate(entry.sx, entry.sy);
          ctx.globalAlpha = alpha * entry.appear * (light ? 0.95 : 1);

          // 外层实线光环
          ctx.strokeStyle = light ? 'rgba(140, 124, 200, 0.34)' : 'rgba(214, 190, 255, 0.34)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(0, 0, coreRadius * 2.7, 0, TWO_PI);
          ctx.stroke();

          // 旋转的虚线轨道 + 同轨卫星点
          ctx.save();
          ctx.rotate(time * 0.22 + entry.phase * 0.12);
          ctx.strokeStyle = light ? 'rgba(140, 124, 200, 0.5)' : 'rgba(214, 190, 255, 0.56)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 7]);
          ctx.beginPath();
          ctx.ellipse(0, 0, orbitRx, orbitRy, 0, 0, TWO_PI);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = palette.core;
          ctx.beginPath();
          ctx.arc(orbitRx, 0, coreRadius * 0.26, 0, TWO_PI);
          ctx.fill();
          ctx.restore();

          // 反向旋转的第二层细轨道，增加纵深
          ctx.save();
          ctx.rotate(-time * 0.16);
          ctx.strokeStyle = light ? 'rgba(140, 124, 200, 0.22)' : 'rgba(214, 190, 255, 0.24)';
          ctx.lineWidth = 1;
          ctx.setLineDash([1.5, 9]);
          ctx.beginPath();
          ctx.arc(0, 0, coreRadius * 1.7, 0, TWO_PI);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();

          // 主点：白心 → 薰衣草紫 → 粉的径向渐变，外圈 aura 负责粉色发光
          const dot = ctx.createRadialGradient(0, 0, 0, 0, 0, coreRadius);
          dot.addColorStop(0, light ? '#fff8fd' : '#ffffff');
          dot.addColorStop(0.38, light ? '#fff8fd' : '#ffffff');
          dot.addColorStop(0.72, palette.mid);
          dot.addColorStop(1, light ? '#e08cc5' : '#ee9fd6');
          ctx.fillStyle = dot;
          ctx.beginPath();
          ctx.arc(0, 0, coreRadius, 0, TWO_PI);
          ctx.fill();
          ctx.restore();
        }

        drawFlare(entry, palette, alpha * entry.appear, time);

        // 到期不改掌握度颜色，只在外圈加一圈脉冲虚线提醒
        if (dueIds.has(entry.id)) {
          const pulse = (Math.sin(time * 2.6) + 1) * 0.5;
          ctx.save();
          ctx.globalAlpha = alpha * entry.appear * (0.55 + pulse * 0.45);
          ctx.strokeStyle = ringColor;
          ctx.lineWidth = 1.3;
          ctx.setLineDash([2.5, 3.5]);
          ctx.beginPath();
          ctx.arc(entry.sx, entry.sy, coreRadius + 3.5 + pulse * 1.6, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }

        ctx.restore();

        // 节点多时只显示章节级标签，具体知识点缩放或选中后再显示，避免满屏小字
        const showLabel =
          isRoot ||
          selected ||
          (entry.node.level <= 1 && (projected.length <= 14 || zoom >= 1.3)) ||
          zoom >= 1.45;
        if (!showLabel) {
          return;
        }

        const fontSize = isRoot ? 19 : 11.5 + clamp(entry.weight, 0, 1) * 2.5;
        let labelX = entry.sx;
        let labelY = entry.sy + radius + (isRoot ? 28 : 27);
        let align: CanvasTextAlign = 'center';
        if (view === 'tree') {
          labelX = entry.sx + radius + 12;
          labelY = entry.sy;
          align = 'left';
        } else if (view === 'timeline') {
          const direction = hash01(`${entry.id}:label`) > 0.5 ? 1 : -1;
          labelY = entry.sy + direction * (radius + 20);
        } else if (!isRoot) {
          // 星系与辐射图的标签沿「中心 → 节点」方向往外放
          const nx = entry.sx - width / 2;
          const ny = entry.sy - height * 0.47;
          const length = Math.hypot(nx, ny) || 1;
          labelX = entry.sx + (nx / length) * (radius + 22);
          labelY = entry.sy + (ny / length) * (radius + 14);
          align = nx >= 0 ? 'left' : 'right';
        }
        ctx.save();
        ctx.globalAlpha = clamp((alpha + 0.08) * entry.appear, 0, 1);
        ctx.font = `${selected || isRoot ? 600 : 500} ${fontSize}px ${FONT_STACK}`;
        ctx.textAlign = align;
        ctx.textBaseline = 'middle';
        const labelText = isRoot ? docRef.current.title : entry.node.title;
        const maxLabelWidth = isRoot
          ? Math.min(width * (view === 'tree' ? 0.34 : 0.46), 340)
          : 240;
        const label = isRoot ? fitCanvasLabel(ctx, labelText, maxLabelWidth) : labelText;
        const showOriginCaption = isRoot && (view === 'galaxy' || view === 'radial');
        if (showOriginCaption) {
          ctx.font = `9px ${FONT_STACK}`;
          ctx.fillStyle = light ? 'rgba(55, 92, 138, 0.6)' : 'rgba(176, 204, 236, 0.66)';
          ctx.fillText('O R I G I N', entry.sx, labelY + 16);
          ctx.font = `600 ${fontSize}px ${FONT_STACK}`;
        }
        ctx.lineWidth = 3.2;
        ctx.strokeStyle = light ? 'rgba(235, 242, 250, 0.82)' : 'rgba(8, 14, 28, 0.8)';
        ctx.strokeText(label, labelX, labelY);
        ctx.fillStyle = light
          ? isRoot || selected
            ? '#26364A'
            : '#53657D'
          : isRoot || selected
            ? '#F8FAFC'
            : '#CBD5E1';
        ctx.fillText(label, labelX, labelY);
        ctx.restore();
      };

      const hitTest = (x: number, y: number): string | null => {
        let best: ProjectedNode | null = null;
        for (const entry of projected) {
          // 开屏过程中星点还挤在中心，先不响应点击，避免误选
          if (entry.appear < 0.55) {
            continue;
          }
          const distance = Math.hypot(x - entry.sx, y - entry.sy);
          if (distance <= Math.max(18, entry.radius + 10)) {
            if (!best || entry.depth > best.depth) {
              best = entry;
            }
          }
        }
        return best?.id ?? null;
      };

      const drawTimelineAxis = (fit: number) => {
        const current = docRef.current;
        const times = current.nodes
          .map((node) => node.lastReviewedAt ?? current.createdAt)
          .filter((time) => Number.isFinite(time));
        if (times.length === 0) {
          return;
        }
        const min = Math.min(...times);
        const max = Math.max(...times);
        const left = project({ x: -1.12, y: 0, z: 0 }, fit).sx;
        const right = project({ x: 1.12, y: 0, z: 0 }, fit).sx;
        const y = height - 68;
        ctx.save();
        ctx.strokeStyle = light ? 'rgba(65, 90, 125, 0.24)' : 'rgba(170, 200, 240, 0.22)';
        ctx.fillStyle = light ? '#667A93' : '#9FB1C9';
        ctx.lineWidth = 1;
        ctx.font = `11px ${FONT_STACK}`;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.textAlign = 'left';
        ctx.fillText(new Date(min).toLocaleDateString('zh-CN'), left, y + 20);
        ctx.textAlign = 'right';
        ctx.fillText(new Date(max).toLocaleDateString('zh-CN'), right, y + 20);
        ctx.textAlign = 'center';
        ctx.fillText('未复习节点按资料创建时间排列', (left + right) / 2, y + 20);
        ctx.restore();
      };

      // 轨道环：根节点周围的极淡椭圆轨，像这片知识星系的引力线，缓慢自转
      const drawOrbits = (time: number, fit: number) => {
        if (view !== 'galaxy' && view !== 'radial') {
          return;
        }
        const nodes = docRef.current.nodes;
        const root = nodes.find((node) => node.parentId === null) ?? nodes[0];
        if (!root) {
          return;
        }
        const point = layout[root.id];
        if (!point) {
          return;
        }
        const center = project(point, fit);
        const base = Math.min(width, height) * fit;
        ctx.save();
        for (let index = 0; index < 3; index += 1) {
          const rx = base * (0.2 + index * 0.12);
          const ry = view === 'galaxy' ? rx * 0.55 : rx;
          ctx.save();
          ctx.translate(center.sx, center.sy);
          ctx.rotate(time * (0.05 + index * 0.015) + index * 0.9);
          ctx.beginPath();
          ctx.ellipse(0, 0, rx, ry, 0, 0, TWO_PI);
          ctx.setLineDash(index === 0 ? [3, 9] : [2, 13]);
          ctx.lineWidth = index === 0 ? 1.2 : 1;
          ctx.strokeStyle = light
            ? `rgba(62, 112, 182, ${0.3 - index * 0.06})`
            : `rgba(158, 205, 255, ${0.22 - index * 0.05})`;
          ctx.stroke();

          // 沿轨道缓慢巡游的光点，让轨道环一眼就能看出在动
          const runner = time * (0.34 + index * 0.09) + index * 1.7;
          const dotX = Math.cos(runner) * rx;
          const dotY = Math.sin(runner) * ry;
          const glow = ctx.createRadialGradient(dotX, dotY, 0, dotX, dotY, 9);
          glow.addColorStop(0, light ? 'rgba(255, 255, 255, 0.98)' : 'rgba(240, 248, 255, 0.98)');
          glow.addColorStop(0.32, light ? 'rgba(84, 146, 219, 0.6)' : 'rgba(140, 196, 255, 0.7)');
          glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(dotX, dotY, 9, 0, TWO_PI);
          ctx.fill();
          ctx.fillStyle = light ? 'rgba(38, 92, 158, 0.9)' : 'rgba(235, 246, 255, 0.95)';
          ctx.beginPath();
          ctx.arc(dotX, dotY, 1.8, 0, TWO_PI);
          ctx.fill();
          ctx.restore();
        }
        ctx.restore();
      };

      // 星尘微粒：围绕节点缓慢公转的小光点，让稀疏的小图也保持「活着」的动感
      const drawMotes = (time: number, entries: ProjectedNode[]) => {
        if (entries.length > 36) {
          return;
        }
        ctx.save();
        for (const entry of entries) {
          if (entry.appear < 0.5) {
            continue;
          }
          const count = entry.node.parentId === null ? 5 : 2;
          const palette = palettes.get(entry.id);
          for (let index = 0; index < count; index += 1) {
            const phase = hash01(`${entry.id}:mote-${index}`) * TWO_PI;
            const speed = 0.22 + hash01(`${entry.id}:mote-s-${index}`) * 0.34;
            const orbit = entry.radius * (1.9 + index * 0.72);
            const angle = time * speed + phase;
            const x = entry.sx + Math.cos(angle) * orbit;
            const y = entry.sy + Math.sin(angle) * orbit * (view === 'galaxy' ? 0.7 : 1);
            const size = 1.1 + hash01(`${entry.id}:mote-r-${index}`) * 1.5;
            const twinkle = 0.4 + 0.6 * Math.sin(time * 1.7 + phase);
            ctx.globalAlpha = clamp(twinkle, 0, 1) * 0.75 * entry.appear;
            ctx.fillStyle = palette
              ? `rgba(${palette.halo}, 0.9)`
              : light
                ? 'rgba(60, 110, 180, 0.8)'
                : 'rgba(220, 235, 255, 0.85)';
            ctx.beginPath();
            ctx.arc(x, y, size, 0, TWO_PI);
            ctx.fill();
          }
        }
        ctx.restore();
      };

      const drawFrame = (timestamp: number) => {
        const time = timestamp / 1000;
        for (const [id, transition] of paletteTransitions) {
          if (transition.start === null) {
            if (document.body.classList.contains('has-modal')) {
              continue;
            }
            transition.start = timestamp;
          }
          const progress = clamp((timestamp - transition.start) / 800, 0, 1);
          if (progress >= 1) {
            palettes.set(id, transition.to);
            paletteTransitions.delete(id);
          } else {
            palettes.set(id, mixPalettes(transition.from, transition.to, progress));
          }
        }
        // 每 2 秒重算一次到期集合：页面跨天、演示时间变化都能跟上
        if (timestamp - lastStatusAt > 2000) {
          refreshDue();
          lastStatusAt = timestamp;
        }
        const fit = Math.min(width, height) / 600;

        // 视差缓动：背景星空比指针慢半拍，像真的置身于这片空间
        parallax.x += (pointer.x * 14 - parallax.x) * 0.05;
        parallax.y += (pointer.y * 10 - parallax.y) * 0.05;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        drawBackground(time);
        drawOrbits(time, fit);
        if (view === 'timeline') {
          drawTimelineAxis(fit);
        }

        if (bloomAt === null) {
          bloomAt = timestamp;
        }
        const bloomAge = timestamp - bloomAt;
        // 开屏收尾后只有星系视图保留缓慢漂移，树形图和时间线保持稳定便于阅读
        const settle = view === 'galaxy' ? clamp((bloomAge - 1600) / 1800, 0, 1) : 0;
        const centerX = width / 2;
        const centerY = height * 0.47;

        const entries = docRef.current.nodes.map((node) => {
          const point = layout[node.id] ?? { x: 0, y: 0, z: 0 };
          const projection = project(point, fit);
          const weight = importance.get(node.id) ?? 0;
          // 星体大小由重要性决定，只保留很小的个体抖动
          const base = (node.parentId === null ? 19 : 9.5 + weight * 7.5) * (view === 'galaxy' ? 1 : 0.78);
          const spark = 0.94 + hash01(`${node.id}:size`) * 0.12;
          // 错峰展开：核心先亮，越外层越晚，个体再带一点随机延迟
          const delay = node.parentId === null ? 0 : 140 + projection.depth * 190 + hash01(`${node.id}:bloom`) * 260;
          const local = clamp((bloomAge - delay) / 1150, 0, 1);
          const open = Math.max(0, easeOutBack(local));
          const appear = clamp(local * 1.4, 0, 1);
          const driftPhase = hash01(`${node.id}:drift`) * TWO_PI;
          const driftSpeed = 0.34 + hash01(`${node.id}:driftspeed`) * 0.26;
          const driftAmp = (4.6 + weight * 5.2) * fit * settle;
          const driftX = Math.sin(time * driftSpeed + driftPhase) * driftAmp;
          const driftY = Math.cos(time * driftSpeed * 0.83 + driftPhase * 1.6) * driftAmp * 0.7;
          return {
            id: node.id,
            node,
            sx: centerX + (projection.sx - centerX) * open + driftX,
            sy: centerY + (projection.sy - centerY) * open + driftY,
            depth: projection.depth,
            radius:
              base *
              spark *
              projection.scale *
              (fit < 0.9 ? 0.9 : 1) *
              (0.18 + 0.82 * clamp(open, 0, 1)),
            phase: hash01(`${node.id}:phase`) * TWO_PI,
            weight,
            appear,
          } as ProjectedNode;
        });
        projected = entries;
        const byId = new Map(entries.map((entry) => [entry.id, entry]));

        drawEdges(time, byId);
        drawMotes(time, entries);

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
        theta = view === 'galaxy' ? DEFAULT_THETA : 0;
        phi = view === 'galaxy' ? DEFAULT_PHI : 0;
        panX = 0;
        panY = 0;
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
        const rect = container.getBoundingClientRect();
        pointer.x = clamp(((event.clientX - rect.left) / Math.max(1, rect.width) - 0.5) * 2, -1, 1);
        pointer.y = clamp(((event.clientY - rect.top) / Math.max(1, rect.height) - 0.5) * 2, -1, 1);
        if (drag && drag.pointerId === event.pointerId) {
          const dx = event.clientX - drag.x;
          const dy = event.clientY - drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) {
            drag.moved = true;
          }
          if (view === 'galaxy') {
            // 默认拖动平移；按住 Shift 或右键拖动才旋转星系
            if (event.shiftKey || (event.buttons & 2) === 2) {
              theta += dx * 0.0075;
              phi = clamp(phi + dy * 0.0055, -1.15, 1.15);
            } else {
              panX += dx;
              panY += dy;
            }
          } else {
            panX += dx;
            panY += dy;
          }
          drag.x = event.clientX;
          drag.y = event.clientY;
          return;
        }
        hoveredId = hitTest(event.clientX - rect.left, event.clientY - rect.top);
        container.style.cursor = hoveredId ? 'pointer' : 'grab';
      };

      const onPointerLeave = () => {
        pointer.x = 0;
        pointer.y = 0;
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

      const onContextMenu = (event: Event) => {
        event.preventDefault();
      };

      container.addEventListener('pointerdown', onPointerDown);
      container.addEventListener('pointermove', onPointerMove);
      container.addEventListener('pointerleave', onPointerLeave);
      container.addEventListener('pointerup', onPointerUp);
      container.addEventListener('pointercancel', onPointerUp);
      container.addEventListener('wheel', onWheel, { passive: false });
      container.addEventListener('contextmenu', onContextMenu);

      raf = requestAnimationFrame(drawFrame);

      return () => {
        cancelAnimationFrame(raf);
        observer.disconnect();
        container.removeEventListener('pointerdown', onPointerDown);
        container.removeEventListener('pointermove', onPointerMove);
        container.removeEventListener('pointerleave', onPointerLeave);
        container.removeEventListener('pointerup', onPointerUp);
        container.removeEventListener('pointercancel', onPointerUp);
        container.removeEventListener('wheel', onWheel);
        container.removeEventListener('contextmenu', onContextMenu);
        container.classList.remove('is-dragging');
        container.style.cursor = '';
        if (canvas.parentElement === container) {
          container.removeChild(canvas);
        }
      };
    }, [theme, view, paletteTheme]);

    return (
      <div
        className="galaxy-canvas-shell"
        ref={containerRef}
        data-testid="graph-canvas"
        role="img"
        aria-label={view === 'galaxy' ? '知识星系，拖动移动、Shift 加拖动旋转、滚轮缩放，点击星点查看内容' : '知识图谱，拖动平移、滚轮缩放，点击节点查看内容'}
      />
    );
  },
);
