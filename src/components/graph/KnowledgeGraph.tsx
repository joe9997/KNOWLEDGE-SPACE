import { useEffect, useRef, useState } from 'react';
import { FileText, Maximize2, Minimize2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import type { KnowledgeDoc } from '../../lib/types';
import type { PaletteTheme } from '../../lib/learningPrefs';
import type { GraphView } from './graphLayout';
import { GalaxyGraph } from './GalaxyGraph';
import type { GalaxyGraphHandle } from './GalaxyGraph';

interface KnowledgeGraphProps {
  doc: KnowledgeDoc;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onExport: () => void;
  offsetDays: number;
  paletteTheme: PaletteTheme;
}

export function KnowledgeGraph({
  doc,
  selectedId,
  onSelect,
  onExport,
  offsetDays,
  paletteTheme,
}: KnowledgeGraphProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const galaxyRef = useRef<GalaxyGraphHandle>(null);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [view, setView] = useState<GraphView>('galaxy');

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === shellRef.current);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

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
      <GalaxyGraph
        ref={galaxyRef}
        doc={doc}
        selectedId={selectedId}
        onSelect={onSelect}
        onZoomChange={setZoomPercent}
        offsetDays={offsetDays}
        view={view}
        paletteTheme={paletteTheme}
      />

      <div className="graph-view-switcher" aria-label="图谱视图类型">
        {([
          ['galaxy', '星系'],
          ['radial', '辐射图'],
          ['tree', '树形图'],
          ['timeline', '时间线'],
        ] as Array<[GraphView, string]>).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="graph-view-button"
            aria-pressed={view === value}
            onClick={() => setView(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="graph-hint">{view === 'galaxy' ? '拖动旋转星系' : '拖动平移图谱'} · 滚轮缩放 · 点击节点查看原文</p>

      {doc.nodes.length === 0 && (
        <p className="source-panel__empty" style={{ position: 'absolute', inset: 0 }}>
          这段材料还没有生成节点。
        </p>
      )}

      <div className="graph-toolbar">
        <div
          className="graph-legend"
          aria-label="节点图例：颜色表示掌握度，红色虚线描边表示已到期"
        >
          <span className="graph-legend__item">
            <i className="graph-legend__dot" data-mastery="0" />没记住
          </span>
          <span className="graph-legend__item">
            <i className="graph-legend__dot" data-mastery="1" />有点模糊
          </span>
          <span className="graph-legend__item">
            <i className="graph-legend__dot" data-mastery="2" />已掌握
          </span>
          <span className="graph-legend__item">
            <i className="graph-legend__dot graph-legend__dot--ring" aria-hidden="true" />
            已到期
          </span>
        </div>

        <div className="graph-toolbar__right">
          <div className="graph-tools">
            <button
              type="button"
              className="tool-button"
              onClick={() => galaxyRef.current?.zoomBy(-1)}
              disabled={zoomPercent <= 60}
              aria-label="缩小"
              title="缩小"
            >
              <ZoomOut size={15} />
            </button>
            <span className="zoom-value">{zoomPercent}%</span>
            <button
              type="button"
              className="tool-button"
              onClick={() => galaxyRef.current?.zoomBy(1)}
              disabled={zoomPercent >= 260}
              aria-label="放大"
              title="放大"
            >
              <ZoomIn size={15} />
            </button>
            <button
              type="button"
              className="tool-button"
              onClick={() => galaxyRef.current?.reset()}
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
