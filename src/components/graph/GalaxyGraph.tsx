import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { DAY_MS, isDue } from '../../lib/review';
import type { KnowledgeDoc, KnowledgeNode, Mastery } from '../../lib/types';
import type { GraphLink, SpherePoint } from './graphLayout';
import { buildGraphLinks, computeGalaxyLayout, GALAXY_ARMS, hash01 } from './graphLayout';

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
  /** 每颗星固定的闪烁相位，避免所有节点同步呼吸 */
  phase: number;
  /** 重要性 0–1：由层级、子节点数、关联数综合而来，决定星球大小 */
  weight: number;
  node: KnowledgeNode;
}

interface NodePalette {
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

/**
 * 颜色只表达「掌握度」，与是否到期无关：
 * 0 没记住 = 玫红 / 珊瑚，1 有点模糊 = 琥珀 / 金橙，2 已掌握 = 薄荷 / 青蓝。
 * 同一掌握度下有多档星光色，按节点 id 稳定分配，让星系有层次但不破坏图例语义。
 * 到期由 drawNode 里的脉冲描边单独提示，不覆盖掌握度颜色。
 */
const PALETTES: Record<Mastery, { dark: NodePalette[]; light: NodePalette[] }> = {
  0: {
    dark: [
      { core: '#FF4D8D', mid: '#FFA8CE', halo: '255, 77, 141' },
      { core: '#FF6B8A', mid: '#FFB7C4', halo: '255, 107, 138' },
      { core: '#E85CC8', mid: '#FFB2EE', halo: '232, 92, 200' },
    ],
    light: [
      { core: '#D6316F', mid: '#F58AB4', halo: '214, 49, 111' },
      { core: '#C64A63', mid: '#EF9DAD', halo: '198, 74, 99' },
      { core: '#B03E9B', mid: '#E394D8', halo: '176, 62, 155' },
    ],
  },
  1: {
    dark: [
      { core: '#FFB020', mid: '#FFDF9A', halo: '255, 176, 32' },
      { core: '#FF8F45', mid: '#FFC9A0', halo: '255, 143, 69' },
      { core: '#FFD84D', mid: '#FFF2A8', halo: '255, 216, 77' },
    ],
    light: [
      { core: '#B4760C', mid: '#E7B34C', halo: '180, 118, 12' },
      { core: '#B4622B', mid: '#E29E73', halo: '180, 98, 43' },
      { core: '#9C8710', mid: '#D8C352', halo: '156, 135, 16' },
    ],
  },
  2: {
    dark: [
      { core: '#2FE3B0', mid: '#9BF5D9', halo: '47, 227, 176' },
      { core: '#3FD0FF', mid: '#A5ECFF', halo: '63, 208, 255' },
      { core: '#78E88F', mid: '#C0F7CB', halo: '120, 232, 143' },
    ],
    light: [
      { core: '#12876A', mid: '#5CCBAB', halo: '18, 135, 106' },
      { core: '#11769E', mid: '#66BBDC', halo: '17, 118, 158' },
      { core: '#2F8C43', mid: '#7BC78C', halo: '47, 140, 67' },
    ],
  },
};

function resolvePalette(node: KnowledgeNode, light: boolean): NodePalette {
  const variants = PALETTES[node.mastery][light ? 'light' : 'dark'];
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

      // 颜色跟着掌握度走：重新评级后调用一次，节点星光颜色原地更新
      const syncScene = () => {
        const current = docRef.current;
        layout = computeGalaxyLayout(current.nodes);
        links = buildGraphLinks(current.nodes, current.relations);
        palettes = new Map(
          current.nodes.map((node) => [node.id, resolvePalette(node, theme === 'light')]),
        );
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
      let theta = DEFAULT_THETA;
      let phi = DEFAULT_PHI;
      let zoom = 1;
      let raf = 0;
      let projected: ProjectedNode[] = [];
      let hoveredId: string | null = null;
      let lastStatusAt = 0;
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

      // 星系盘贴图：正面对着画一次旋臂 + 核球，之后每帧只做旋转 / 压扁，和节点共用同一套投影
      const disc = document.createElement('canvas');
      const discCtx = disc.getContext('2d');
      const DISC_SIZE = 1024;

      const renderGalaxyDisc = () => {
        if (!discCtx) {
          return;
        }
        disc.width = DISC_SIZE;
        disc.height = DISC_SIZE;
        const center = DISC_SIZE / 2;
        const maxR = center;
        discCtx.clearRect(0, 0, DISC_SIZE, DISC_SIZE);

        // 旋臂星尘：越靠外越稀薄，转角与 computeGalaxyLayout 的旋臂公式一致
        discCtx.globalCompositeOperation = 'lighter';
        const starCount = 6000;
        for (let index = 0; index < starCount; index += 1) {
          const arm = index % GALAXY_ARMS;
          const t = Math.pow(hash01(`arm-r-${index}`), 0.62);
          const unitRadius = 0.05 + t * 0.95;
          const radius = unitRadius * maxR * 0.96;
          const theta =
            (arm / GALAXY_ARMS) * TWO_PI +
            unitRadius * 2.6 +
            (hash01(`arm-a-${index}`) - 0.5) * (0.3 + t * 0.34);
          const x = center + Math.cos(theta) * radius;
          const y = center + Math.sin(theta) * radius;
          const size = 0.4 + hash01(`arm-s-${index}`) * (1.15 - t * 0.65);
          const alpha = (0.16 + hash01(`arm-o-${index}`) * 0.6) * (1 - t * 0.4);
          const warm = hash01(`arm-w-${index}`) > 0.86;
          discCtx.fillStyle = warm
            ? `rgba(255, 216, 160, ${alpha * (light ? 0.7 : 0.85)})`
            : light
              ? `rgba(58, 102, 172, ${alpha * 0.9})`
              : `rgba(198, 224, 255, ${alpha})`;
          discCtx.beginPath();
          discCtx.arc(x, y, size, 0, TWO_PI);
          discCtx.fill();
        }
        discCtx.globalCompositeOperation = 'source-over';

        // 核球：暖白椭圆光，压扁后就是星系中央的棒状亮核
        const bulge = discCtx.createRadialGradient(center, center, 0, center, center, maxR * 0.36);
        if (light) {
          bulge.addColorStop(0, 'rgba(255, 236, 196, 0.95)');
          bulge.addColorStop(0.3, 'rgba(255, 210, 150, 0.6)');
          bulge.addColorStop(0.66, 'rgba(214, 160, 96, 0.22)');
          bulge.addColorStop(1, 'rgba(200, 150, 90, 0)');
        } else {
          bulge.addColorStop(0, 'rgba(255, 247, 226, 0.95)');
          bulge.addColorStop(0.3, 'rgba(255, 226, 172, 0.6)');
          bulge.addColorStop(0.66, 'rgba(255, 198, 122, 0.2)');
          bulge.addColorStop(1, 'rgba(255, 190, 120, 0)');
        }
        discCtx.save();
        discCtx.translate(center, center);
        discCtx.rotate(0.45);
        discCtx.scale(1, 0.44);
        discCtx.fillStyle = bulge;
        discCtx.beginPath();
        discCtx.arc(0, 0, maxR * 0.36, 0, TWO_PI);
        discCtx.fill();
        discCtx.restore();
      };
      renderGalaxyDisc();

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

        // 星系盘：把正面贴图按同一投影旋转、压扁，旋臂始终和节点对齐
        if (discCtx) {
          const discRadius = focal * 0.62;
          ctx.save();
          ctx.translate(width / 2, height * 0.47);
          ctx.rotate(theta);
          ctx.scale(1, Math.max(0.3, Math.sin(phi)));
          ctx.globalAlpha = light ? 0.95 : 1;
          ctx.drawImage(disc, -discRadius, -discRadius, discRadius * 2, discRadius * 2);
          ctx.restore();
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

          if (link.kind === 'tree') {
            const progress = (time * 0.075 + index * 0.17) % 1;
            const inv = 1 - progress;
            const px =
              inv * inv * from.sx + 2 * inv * progress * controlX + progress * progress * to.sx;
            const py =
              inv * inv * from.sy + 2 * inv * progress * controlY + progress * progress * to.sy;
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
        const isRoot = entry.node.parentId === null;
        if (!active && !isRoot) {
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
        const palette = palettes.get(entry.id) ?? resolvePalette(entry.node, light);
        const selected = selectedIdRef.current === entry.id;
        const hovered = hoveredId === entry.id;
        const active = selected || hovered;
        const nearness = entry.depth / 2 + 0.5;
        const alpha = (0.55 + nearness * 0.45) * (active ? 1 : 0.94);
        const radius = entry.radius * (selected ? 1.18 : hovered ? 1.1 : 1);
        const haloRadius = radius * (entry.node.parentId === null ? 4.4 : 3.7);
        const breath = 1 + 0.07 * Math.sin(time * 1.9 + entry.phase);

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

        drawFlare(entry, palette, alpha, time);

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
        const fontSize = isRoot ? 17 : 11.5 + clamp(entry.weight, 0, 1) * 2.5;
        // 非核心节点的标签沿「中心 → 节点」方向往外放，避免全部堆在星系中央
        let labelX = entry.sx;
        let labelY = entry.sy + radius + 27;
        let align: CanvasTextAlign = 'center';
        if (!isRoot) {
          const nx = entry.sx - width / 2;
          const ny = entry.sy - height * 0.47;
          const length = Math.hypot(nx, ny) || 1;
          labelX = entry.sx + (nx / length) * (radius + 22);
          labelY = entry.sy + (ny / length) * (radius + 14);
          align = nx >= 0 ? 'left' : 'right';
        }
        ctx.save();
        ctx.globalAlpha = clamp(alpha + 0.08, 0, 1);
        ctx.font = `${selected || isRoot ? 600 : 500} ${fontSize}px ${FONT_STACK}`;
        ctx.textAlign = align;
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3.2;
        ctx.strokeStyle = light ? 'rgba(235, 242, 250, 0.82)' : 'rgba(8, 14, 28, 0.8)';
        ctx.strokeText(entry.node.title, labelX, labelY);
        ctx.fillStyle = light
          ? isRoot || selected
            ? '#26364A'
            : '#53657D'
          : isRoot || selected
            ? '#F8FAFC'
            : '#CBD5E1';
        ctx.fillText(entry.node.title, labelX, labelY);
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
        const fit = Math.min(width, height) / 600;

        // 视差缓动：背景星空比指针慢半拍，像真的置身于这片空间
        parallax.x += (pointer.x * 14 - parallax.x) * 0.05;
        parallax.y += (pointer.y * 10 - parallax.y) * 0.05;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        drawBackground(time);

        const entries = docRef.current.nodes.map((node) => {
          const point = layout[node.id] ?? { x: 0, y: 0, z: 0 };
          const projection = project(point, fit);
          const weight = importance.get(node.id) ?? 0;
          // 星体大小由重要性决定，只保留很小的个体抖动
          const base = node.parentId === null ? 19 : 9.5 + weight * 7.5;
          const spark = 0.94 + hash01(`${node.id}:size`) * 0.12;
          return {
            id: node.id,
            node,
            sx: projection.sx,
            sy: projection.sy,
            depth: projection.depth,
            radius: base * spark * projection.scale * (fit < 0.9 ? 0.9 : 1),
            phase: hash01(`${node.id}:phase`) * TWO_PI,
            weight,
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
        const rect = container.getBoundingClientRect();
        pointer.x = clamp(((event.clientX - rect.left) / Math.max(1, rect.width) - 0.5) * 2, -1, 1);
        pointer.y = clamp(((event.clientY - rect.top) / Math.max(1, rect.height) - 0.5) * 2, -1, 1);
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

      container.addEventListener('pointerdown', onPointerDown);
      container.addEventListener('pointermove', onPointerMove);
      container.addEventListener('pointerleave', onPointerLeave);
      container.addEventListener('pointerup', onPointerUp);
      container.addEventListener('pointercancel', onPointerUp);
      container.addEventListener('wheel', onWheel, { passive: false });

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
        container.classList.remove('is-dragging');
        container.style.cursor = '';
        if (canvas.parentElement === container) {
          container.removeChild(canvas);
        }
      };
    }, [theme]);

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
