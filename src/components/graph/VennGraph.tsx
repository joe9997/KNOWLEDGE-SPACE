import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { DAY_MS, isDue } from '../../lib/review';
import type { KnowledgeDoc, KnowledgeNode } from '../../lib/types';
import { paletteVariant } from '../../lib/learningPrefs';
import type { PaletteTheme } from '../../lib/learningPrefs';

interface VennGraphProps {
  doc: KnowledgeDoc;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onZoomChange: (percent: number) => void;
  /** 演示时间偏移（天），与星系视图共用同一个“现在” */
  offsetDays: number;
  paletteTheme: PaletteTheme;
}

export interface VennGraphHandle {
  zoomBy: (delta: number) => void;
  reset: () => void;
}

interface VennGroup {
  key: string;
  title: string;
  nodes: KnowledgeNode[];
}

const VIEW_W = 680;
const VIEW_H = 500;
const CENTER_X = VIEW_W / 2;
const CENTER_Y = VIEW_H / 2;
const CIRCLE_R = 168;
const CENTER_OFFSET = 88;
const MAX_PER_GROUP = 8;
const LABEL_MAX = 6;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.6;
const MIN_PAN_MOVE = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 按一级分支把节点分进最多三个集合；分支太少时退化为均分 */
function buildGroups(doc: KnowledgeDoc): VennGroup[] {
  const nodes = doc.nodes;
  if (nodes.length <= 1) {
    return [];
  }
  const root = nodes.find((node) => node.parentId === null) ?? nodes[0];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = nodes.filter((node) => node.parentId === root.id);
  const nonRoot = nodes.filter((node) => node.id !== root.id);

  if (children.length >= 2) {
    const groups: VennGroup[] = children.slice(0, 3).map((seed) => ({
      key: seed.id,
      title: seed.title,
      nodes: [],
    }));
    const groupOf = new Map(groups.map((group) => [group.key, group]));

    const topAncestor = (node: KnowledgeNode): string => {
      let cursor = node;
      for (let depth = 0; depth < 16; depth += 1) {
        const parent = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        if (!parent || parent.id === root.id) {
          return cursor.id;
        }
        cursor = parent;
      }
      return cursor.id;
    };

    nonRoot.forEach((node) => {
      const group =
        groupOf.get(topAncestor(node)) ??
        groups.reduce((smallest, current) =>
          current.nodes.length < smallest.nodes.length ? current : smallest,
        );
      group.nodes.push(node);
    });
    return groups;
  }

  const count = Math.min(3, Math.max(1, Math.ceil(nonRoot.length / 3)));
  const groups: VennGroup[] = nonRoot.slice(0, count).map((node) => ({
    key: node.id,
    title: node.title,
    nodes: [node],
  }));
  nonRoot.slice(count).forEach((node, index) => {
    groups[index % groups.length].nodes.push(node);
  });
  return groups;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export const VennGraph = forwardRef<VennGraphHandle, VennGraphProps>(function VennGraph(
  { doc, selectedId, onSelect, onZoomChange, offsetDays, paletteTheme },
  ref,
) {
  const [light, setLight] = useState(
    () => document.documentElement.dataset.theme === 'light',
  );
  const shellRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewRef = useRef({ x: 0, y: 0, scale: 1 });
  const zoomPercentRef = useRef(100);
  const onZoomChangeRef = useRef(onZoomChange);
  const suppressClickRef = useRef(0);

  useEffect(() => {
    onZoomChangeRef.current = onZoomChange;
  }, [onZoomChange]);

  const applyTransform = () => {
    const svg = svgRef.current;
    if (!svg) {
      return;
    }
    const { x, y, scale } = viewRef.current;
    svg.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
  };

  const notifyZoom = () => {
    const percent = Math.round(viewRef.current.scale * 100);
    if (percent === zoomPercentRef.current) {
      return;
    }
    zoomPercentRef.current = percent;
    onZoomChangeRef.current(percent);
  };

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const svg = svgRef.current;
    if (!svg) {
      return;
    }
    const view = viewRef.current;
    const rect = svg.getBoundingClientRect();
    // rect 已经包含当前平移与缩放，先换算回未变换时的基准坐标
    const cursorX = clientX - (rect.left - view.x);
    const cursorY = clientY - (rect.top - view.y);
    const nextScale = clamp(view.scale * factor, MIN_ZOOM, MAX_ZOOM);
    if (nextScale === view.scale) {
      return;
    }
    const ratio = nextScale / view.scale;
    view.x = cursorX - (cursorX - view.x) * ratio;
    view.y = cursorY - (cursorY - view.y) * ratio;
    view.scale = nextScale;
    applyTransform();
    notifyZoom();
  };

  const resetView = () => {
    viewRef.current = { x: 0, y: 0, scale: 1 };
    applyTransform();
    zoomPercentRef.current = 100;
    onZoomChangeRef.current(100);
  };

  const zoomBy = (delta: number) => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    const rect = shell.getBoundingClientRect();
    zoomAt(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      delta > 0 ? 1.18 : 1 / 1.18,
    );
  };

  useImperativeHandle(ref, () => ({ zoomBy, reset: resetView }));

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setLight(document.documentElement.dataset.theme === 'light');
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  // 切换文档时回到默认视图，避免上一份材料的平移量残留
  useEffect(() => {
    viewRef.current = { x: 0, y: 0, scale: 1 };
    applyTransform();
    zoomPercentRef.current = 100;
    onZoomChangeRef.current(100);
  }, [doc.id]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, event.deltaY > 0 ? 0.92 : 1.08);
    };
    shell.addEventListener('wheel', onWheel, { passive: false });
    return () => shell.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    let drag: {
      pointerId: number;
      startX: number;
      startY: number;
      originX: number;
      originY: number;
      moved: boolean;
    } | null = null;
    let frame = 0;

    const scheduleTransform = () => {
      if (frame) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        applyTransform();
      });
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) {
        return;
      }
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: viewRef.current.x,
        originY: viewRef.current.y,
        moved: false,
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < MIN_PAN_MOVE) {
          return;
        }
        drag.moved = true;
        shell.classList.add('is-panning');
        try {
          shell.setPointerCapture(event.pointerId);
        } catch {
          // 某些浏览器或触摸场景不支持捕获，窗口监听仍能收到 pointerup
        }
      }
      viewRef.current.x = drag.originX + dx;
      viewRef.current.y = drag.originY + dy;
      scheduleTransform();
    };

    const finishDrag = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      const wasMoved = drag.moved;
      const pointerId = drag.pointerId;
      drag = null;
      shell.classList.remove('is-panning');
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
        applyTransform();
      }
      try {
        if (shell.hasPointerCapture(pointerId)) {
          shell.releasePointerCapture(pointerId);
        }
      } catch {
        // 忽略已释放的指针
      }
      if (wasMoved) {
        suppressClickRef.current = performance.now() + 260;
      }
    };

    shell.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    return () => {
      shell.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
      if (frame) {
        cancelAnimationFrame(frame);
      }
    };
  }, []);

  const layout = useMemo(() => {
    const root = doc.nodes.find((node) => node.parentId === null) ?? doc.nodes[0] ?? null;
    const groups = buildGroups(doc);
    const angles =
      groups.length === 1 ? [0] : groups.length === 2 ? [-90, 90] : [-90, 30, 150];

    const circles = groups.map((group, index) => {
      const angle = (angles[index] ?? 0) * (Math.PI / 180);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const cx = CENTER_X + cos * CENTER_OFFSET;
      const cy = CENTER_Y + sin * CENTER_OFFSET;
      const lobeDistance = CENTER_OFFSET + CIRCLE_R * 0.5;
      const lobeX = CENTER_X + cos * lobeDistance;
      const lobeY = CENTER_Y + sin * lobeDistance;

      const shown = group.nodes.slice(0, MAX_PER_GROUP);
      const columns = shown.length <= 2 ? 1 : 2;
      const rows = Math.max(1, Math.ceil(shown.length / columns));
      const positions = shown.map((node, nodeIndex) => {
        const column = nodeIndex % columns;
        const row = Math.floor(nodeIndex / columns);
        return {
          node,
          x: lobeX + (column - (columns - 1) / 2) * 64,
          y: lobeY + (row - (rows - 1) / 2) * 30,
        };
      });

      return {
        group,
        angle,
        cx,
        cy,
        positions,
        hidden: Math.max(0, group.nodes.length - shown.length),
      };
    });

    const positionsById = new Map<string, { x: number; y: number }>();
    circles.forEach((circle) => {
      circle.positions.forEach((item) => {
        positionsById.set(item.node.id, { x: item.x, y: item.y });
      });
    });
    if (root) {
      positionsById.set(root.id, { x: CENTER_X, y: CENTER_Y });
    }

    const relations = doc.relations.filter(
      (relation) =>
        relation.from !== relation.to &&
        positionsById.has(relation.from) &&
        positionsById.has(relation.to),
    );

    return { root, circles, positionsById, relations };
  }, [doc]);

  const now = Date.now() + offsetDays * DAY_MS;

  return (
    <div
      className="venn-shell"
      ref={shellRef}
      onClickCapture={(event) => {
        if (performance.now() < suppressClickRef.current) {
          suppressClickRef.current = 0;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <svg
        ref={svgRef}
        className="venn-graph"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={`韦恩图：${doc.title}`}
      >
        <defs>
          {/* 主点：白心 → 薰衣草紫 → 粉的径向渐变 */}
          <radialGradient id="venn-origin-core" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" className="venn-origin-core__hot" />
            <stop offset="38%" className="venn-origin-core__hot" />
            <stop offset="72%" className="venn-origin-core__mid" />
            <stop offset="100%" className="venn-origin-core__edge" />
          </radialGradient>
          {/* 外发光：粉色径向渐变，向外淡出 */}
          <radialGradient id="venn-origin-glow">
            <stop offset="0%" className="venn-origin-glow__inner" />
            <stop offset="52%" className="venn-origin-glow__mid" />
            <stop offset="100%" className="venn-origin-glow__outer" />
          </radialGradient>
        </defs>

        {layout.circles.map((circle) => {
          const labelX = circle.cx + Math.cos(circle.angle) * CIRCLE_R * 0.74;
          const labelY = circle.cy + Math.sin(circle.angle) * CIRCLE_R * 0.74;
          return (
            <g key={`circle-${circle.group.key}`} className="venn-set">
              <circle
                cx={circle.cx}
                cy={circle.cy}
                r={CIRCLE_R}
                className="venn-set__disc"
              />
              <text x={labelX} y={labelY} className="venn-set__label" textAnchor="middle">
                {truncate(circle.group.title, 9)}
              </text>
              {circle.hidden > 0 && (
                <text
                  x={labelX}
                  y={labelY + 15}
                  className="venn-set__more"
                  textAnchor="middle"
                >
                  +{circle.hidden}
                </text>
              )}
            </g>
          );
        })}

        {layout.relations.map((relation, index) => {
          const from = layout.positionsById.get(relation.from)!;
          const to = layout.positionsById.get(relation.to)!;
          const midX = (from.x + to.x) / 2;
          const midY = (from.y + to.y) / 2;
          const nx = -(to.y - from.y);
          const ny = to.x - from.x;
          const length = Math.hypot(nx, ny) || 1;
          const bend = 16;
          const controlX = midX + (nx / length) * bend;
          const controlY = midY + (ny / length) * bend;
          return (
            <path
              key={`rel-${index}`}
              className="venn-relation"
              d={`M ${from.x} ${from.y} Q ${controlX} ${controlY} ${to.x} ${to.y}`}
            />
          );
        })}

        {layout.circles.flatMap((circle) =>
          circle.positions.map((item) => {
            const node = item.node;
            const selected = node.id === selectedId;
            const color = paletteVariant(paletteTheme, node.mastery, light, 1);
            const due = isDue(node.nextReviewAt, now);
            return (
              <g
                key={node.id}
                className={`venn-node ${selected ? 'is-selected' : ''}`.trim()}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                onClick={() => onSelect(node.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(node.id);
                  }
                }}
              >
                <title>{`${node.title} · ${node.mastery === 2 ? '已掌握' : node.mastery === 1 ? '有点模糊' : '没记住'}`}</title>
                <circle
                  cx={item.x}
                  cy={item.y}
                  r={selected ? 11 : 7}
                  fill={`rgba(${color.halo}, 0.22)`}
                />
                <circle
                  cx={item.x}
                  cy={item.y}
                  r={selected ? 7.5 : 5}
                  fill={color.core}
                  stroke={selected ? color.mid : 'transparent'}
                  strokeWidth={selected ? 2 : 0}
                />
                {due && (
                  <circle
                    cx={item.x}
                    cy={item.y}
                    r={selected ? 14 : 10}
                    className="venn-node__due"
                  />
                )}
                <text
                  x={item.x}
                  y={item.y + 19}
                  className="venn-node__label"
                  textAnchor="middle"
                >
                  {truncate(node.title, LABEL_MAX)}
                </text>
              </g>
            );
          }),
        )}

        {layout.root && (
          <g
            className={`venn-node venn-node--root ${
              layout.root.id === selectedId ? 'is-selected' : ''
            }`.trim()}
            role="button"
            tabIndex={0}
            aria-pressed={layout.root.id === selectedId}
            onClick={() => onSelect(layout.root!.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(layout.root!.id);
              }
            }}
          >
            <title>{doc.title}</title>
            {/* 粉色径向渐变光晕，像参考图里的发光节点 */}
            <circle
              cx={CENTER_X}
              cy={CENTER_Y}
              r={36}
              fill="url(#venn-origin-glow)"
              className="venn-origin__glow"
            />
            {/* 外圈实线光环，参考品牌标志的轨道图标 */}
            <circle cx={CENTER_X} cy={CENTER_Y} r={29} className="venn-origin__rim" />
            <g
              className="venn-origin__rings"
              style={{ transformOrigin: `${CENTER_X}px ${CENTER_Y}px` }}
            >
              <ellipse
                cx={CENTER_X}
                cy={CENTER_Y}
                rx={24}
                ry={13.5}
                className="venn-origin__orbit"
              />
              <circle
                cx={CENTER_X + 24}
                cy={CENTER_Y}
                r={2.2}
                className="venn-origin__satellite"
              />
            </g>
            {/* 反向旋转的第二层细轨道，增加纵深 */}
            <g
              className="venn-origin__rings venn-origin__rings--reverse"
              style={{ transformOrigin: `${CENTER_X}px ${CENTER_Y}px` }}
            >
              <circle
                cx={CENTER_X}
                cy={CENTER_Y}
                r={20}
                className="venn-origin__orbit venn-origin__orbit--soft"
              />
            </g>
            {/* 主节点：白心渐变主点 */}
            <circle cx={CENTER_X} cy={CENTER_Y} r={6.5} className="venn-origin__core" />
            <circle cx={CENTER_X} cy={CENTER_Y} r={26} className="venn-origin__hit" />
            <text
              x={CENTER_X}
              y={CENTER_Y + 44}
              className="venn-node__root-label"
              textAnchor="middle"
            >
              {truncate(doc.title, 20)}
            </text>
            <text
              x={CENTER_X}
              y={CENTER_Y + 60}
              className="venn-origin__caption"
              textAnchor="middle"
            >
              O R I G I N
            </text>
          </g>
        )}
      </svg>
    </div>
  );
});
