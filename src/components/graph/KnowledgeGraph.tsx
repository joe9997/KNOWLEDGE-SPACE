import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  FileText,
  Maximize2,
  Minimize2,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { STATUS_LABEL, statusOf } from '../../lib/review';
import type { GraphPosition, KnowledgeDoc } from '../../lib/types';
import { useApp } from '../../state/AppStore';
import {
  buildGraphLinks,
  computeGraphLayout,
  curvePath,
  layoutExtent,
  nodeTransform,
} from './graphLayout';

interface KnowledgeGraphProps {
  doc: KnowledgeDoc;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onExport: () => void;
}

interface NodeDrag {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  base: GraphPosition;
  latest: GraphPosition;
  moved: boolean;
  frame: number;
}

interface PanDrag {
  pointerId: number;
  startX: number;
  startY: number;
  base: GraphPosition;
  latest: GraphPosition;
  frame: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function KnowledgeGraph({ doc, selectedId, onSelect, onExport }: KnowledgeGraphProps) {
  const { now } = useApp();
  const structureKey = doc.nodes.map((node) => node.id).join('|');
  const layout = useMemo(() => computeGraphLayout(doc.nodes), [structureKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const links = useMemo(
    () => buildGraphLinks(doc.nodes, doc.relations),
    [doc.nodes, doc.relations],
  );

  const shellRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const nodeEls = useRef(new Map<string, HTMLDivElement>());
  const linkEls = useRef(new Map<string, SVGPathElement>());
  const positionsRef = useRef<Record<string, GraphPosition>>(layout);
  const fitRef = useRef(0.85);
  const zoomRef = useRef(1);
  const panRef = useRef<GraphPosition>({ x: 0, y: 0 });
  const dragRef = useRef<NodeDrag | null>(null);
  const panDragRef = useRef<PanDrag | null>(null);
  const didDragRef = useRef(false);

  const [positions, setPositions] = useState<Record<string, GraphPosition>>(layout);
  const [fit, setFit] = useState(0.85);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<GraphPosition>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // 只在节点结构变化时重置布局（复习更新不改变结构）
  useEffect(() => {
    positionsRef.current = layout;
    setPositions(layout);
    setZoom(1);
    zoomRef.current = 1;
    setPan({ x: 0, y: 0 });
    panRef.current = { x: 0, y: 0 };
  }, [layout]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    const updateFit = () => {
      const rect = shell.getBoundingClientRect();
      const extent = layoutExtent(positionsRef.current);
      const next = clamp(
        Math.min((rect.width - 70) / extent.width, (rect.height - 120) / extent.height),
        0.42,
        1.08,
      );
      fitRef.current = next;
      setFit(next);
    };
    updateFit();
    const observer = new ResizeObserver(updateFit);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [layout]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === shellRef.current);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      const next = clamp(zoomRef.current + (event.deltaY > 0 ? -0.08 : 0.08), 0.7, 2.4);
      zoomRef.current = next;
      setZoom(next);
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, []);

  const updateLinksFor = (id: string) => {
    links.forEach((link) => {
      if (link.from !== id && link.to !== id) {
        return;
      }
      const path = linkEls.current.get(`${link.kind}:${link.from}:${link.to}`);
      const from = positionsRef.current[link.from];
      const to = positionsRef.current[link.to];
      if (path && from && to) {
        path.setAttribute('d', curvePath(from, to, link.kind === 'tree' ? 0.075 : -0.06));
      }
    });
  };

  const applyNodeDrag = () => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    drag.frame = 0;
    positionsRef.current = { ...positionsRef.current, [drag.id]: drag.latest };
    const element = nodeEls.current.get(drag.id);
    if (element) {
      element.style.transform = nodeTransform(drag.latest);
    }
    updateLinksFor(drag.id);
  };

  const endNodeDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (drag.frame) {
      cancelAnimationFrame(drag.frame);
      applyNodeDrag();
    }
    const finalPosition = drag.latest;
    if (drag.moved) {
      positionsRef.current = { ...positionsRef.current, [drag.id]: finalPosition };
      setPositions((prev) => ({ ...prev, [drag.id]: finalPosition }));
    }
    didDragRef.current = drag.moved;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onNodePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    didDragRef.current = false;
    const base = positionsRef.current[id];
    if (!base) {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 某些浏览器在合成事件下不支持捕获，继续使用普通移动事件
    }
    dragRef.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base,
      latest: base,
      moved: false,
      frame: 0,
    };
  };

  const onNodePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const dx = (event.clientX - drag.startX) / (fitRef.current * zoomRef.current);
    const dy = (event.clientY - drag.startY) / (fitRef.current * zoomRef.current);
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) {
      drag.moved = true;
    }
    drag.latest = { x: drag.base.x + dx, y: drag.base.y + dy };
    if (!drag.frame) {
      drag.frame = requestAnimationFrame(applyNodeDrag);
    }
  };

  const onNodePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    endNodeDrag(event);
  };

  const applyPan = () => {
    const drag = panDragRef.current;
    if (!drag) {
      return;
    }
    drag.frame = 0;
    panRef.current = drag.latest;
    if (worldRef.current) {
      worldRef.current.style.transform = `translate(${drag.latest.x}px, ${drag.latest.y}px) scale(${
        fitRef.current * zoomRef.current
      })`;
    }
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (drag.frame) {
      cancelAnimationFrame(drag.frame);
      applyPan();
    }
    setPan(drag.latest);
    panRef.current = drag.latest;
    panDragRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    if ((event.target as Element).closest('.graph-node, .graph-toolbar')) {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 忽略捕获失败
    }
    panDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base: panRef.current,
      latest: panRef.current,
      frame: 0,
    };
    setIsPanning(true);
  };

  const onViewportPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    drag.latest = {
      x: drag.base.x + (event.clientX - drag.startX),
      y: drag.base.y + (event.clientY - drag.startY),
    };
    if (!drag.frame) {
      drag.frame = requestAnimationFrame(applyPan);
    }
  };

  const changeZoom = (delta: number) => {
    const next = clamp(zoomRef.current + delta, 0.7, 2.4);
    zoomRef.current = next;
    setZoom(next);
  };

  const resetView = () => {
    positionsRef.current = layout;
    setPositions(layout);
    zoomRef.current = 1;
    setZoom(1);
    panRef.current = { x: 0, y: 0 };
    setPan({ x: 0, y: 0 });
  };

  const toggleFullscreen = async () => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await shell.requestFullscreen();
      }
    } catch {
      setIsFullscreen(false);
    }
  };

  return (
    <div className="graph-shell" ref={shellRef}>
      <div
        className={`graph-viewport ${isPanning ? 'is-panning' : ''}`.trim()}
        ref={viewportRef}
        onPointerDown={onViewportPointerDown}
        onPointerMove={onViewportPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onLostPointerCapture={endPan}
        aria-label="知识网络画布，可拖动节点、平移与缩放"
        data-testid="graph-canvas"
      >
        <div
          className="graph-world"
          ref={worldRef}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${fit * zoom})`,
            transformOrigin: '0 0',
          }}
        >
          <div className="graph-rings" aria-hidden="true">
            {[200, 290, 390].map((radius) => (
              <span
                key={radius}
                className="graph-ring"
                style={{ width: radius * 2, height: radius * 2 }}
              />
            ))}
          </div>

          <svg className="graph-links" width={1} height={1} aria-hidden="true">
            {links.map((link) => {
              const from = positions[link.from];
              const to = positions[link.to];
              if (!from || !to) {
                return null;
              }
              return (
                <path
                  key={`${link.kind}-${link.from}-${link.to}`}
                  ref={(element) => {
                    const key = `${link.kind}:${link.from}:${link.to}`;
                    if (element) {
                      linkEls.current.set(key, element);
                    } else {
                      linkEls.current.delete(key);
                    }
                  }}
                  className={`graph-link graph-link--${link.kind}`}
                  d={curvePath(from, to, link.kind === 'tree' ? 0.075 : -0.06)}
                />
              );
            })}
          </svg>

          {doc.nodes.map((node) => {
            const position = positions[node.id];
            if (!position) {
              return null;
            }
            const status = statusOf(node, now);
            const noSource = node.quoteStart < 0;
            const isCore = node.level === 0 || node.id === doc.nodes[0]?.id;
            return (
              <div
                key={node.id}
                className="graph-node-wrap"
                ref={(element) => {
                  if (element) {
                    nodeEls.current.set(node.id, element);
                  } else {
                    nodeEls.current.delete(node.id);
                  }
                }}
                style={{ transform: nodeTransform(position) }}
              >
                <button
                  type="button"
                  className={[
                    'graph-node',
                    isCore ? 'is-core' : '',
                    noSource ? 'is-no-source' : '',
                    selectedId === node.id ? 'is-selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-node-id={node.id}
                  data-status={status}
                  onClick={() => {
                    if (didDragRef.current) {
                      didDragRef.current = false;
                      return;
                    }
                    onSelect(node.id);
                  }}
                  onPointerDown={(event) => onNodePointerDown(event, node.id)}
                  onPointerMove={onNodePointerMove}
                  onPointerUp={endNodeDrag}
                  onPointerCancel={onNodePointerCancel}
                  onLostPointerCapture={endNodeDrag}
                  aria-label={`${node.title} · ${STATUS_LABEL[status]}${
                    noSource ? ' · 无出处' : ''
                  }`}
                  aria-pressed={selectedId === node.id}
                >
                  <span className="graph-node__dot" aria-hidden="true" />
                  <span className="graph-node__label">{node.title}</span>
                  {noSource && <span className="graph-node__no-source">无出处</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <p className="graph-hint">拖动节点 · 拖动空白平移 · Ctrl / ⌘ + 滚轮缩放</p>

      {doc.nodes.length === 0 && (
        <p className="source-panel__empty" style={{ position: 'absolute', inset: 0 }}>
          这段材料还没有生成节点。
        </p>
      )}

      <div className="graph-toolbar">
        <div className="graph-legend" aria-label="节点状态图例">
          <span className="graph-legend__item">
            <i className="graph-legend__dot" data-status="due" />待复习
          </span>
          <span className="graph-legend__item">
            <i className="graph-legend__dot" data-status="fuzzy" />模糊
          </span>
          <span className="graph-legend__item">
            <i className="graph-legend__dot" data-status="mastered" />已掌握
          </span>
          <span className="graph-legend__item">
            <i className="graph-legend__dot" data-status="none" />无出处
          </span>
        </div>

        <div className="graph-toolbar__right">
          <div className="graph-tools">
            <button
              type="button"
              className="tool-button"
              onClick={() => changeZoom(-0.12)}
              disabled={zoom <= 0.7}
              aria-label="缩小"
              title="缩小"
            >
              <ZoomOut size={15} />
            </button>
            <span className="zoom-value">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              className="tool-button"
              onClick={() => changeZoom(0.12)}
              disabled={zoom >= 2.4}
              aria-label="放大"
              title="放大"
            >
              <ZoomIn size={15} />
            </button>
            <button
              type="button"
              className="tool-button"
              onClick={resetView}
              aria-label="重置视图"
              title="重置视图"
            >
              <RotateCcw size={14} />
            </button>
            <button
              type="button"
              className="tool-button"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? '退出全屏' : '全屏查看'}
              title={isFullscreen ? '退出全屏' : '全屏查看'}
            >
              {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          </div>
          <button type="button" className="toolbar-export" onClick={onExport}>
            <FileText size={13} />
            导出笔记
          </button>
        </div>
      </div>
    </div>
  );
}
