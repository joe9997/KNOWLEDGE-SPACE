import { useEffect, useMemo, useState } from 'react';
import { Info, BookOpen } from 'lucide-react';
import { KnowledgeGraph } from '../components/graph/KnowledgeGraph';
import { SourcePanel } from '../components/source/SourcePanel';
import { TimeTravel } from '../components/TimeTravel';
import { DEMO_NOTICE } from '../data/demo';
import { countRelations, downloadMarkdown } from '../lib/exportMarkdown';
import { isDue } from '../lib/review';
import type { AppView, KnowledgeDoc } from '../lib/types';
import { useApp } from '../state/AppStore';

interface GraphPageProps {
  doc: KnowledgeDoc | null;
  onStartQuiz: (nodeIds: string[]) => void;
  onNavigate: (view: AppView) => void;
}

const ORIGIN_LABEL: Record<KnowledgeDoc['origin'], string> = {
  demo: '体验材料',
  local: '本地规则整理 · 不调用 AI',
  ai: 'AI 整理',
};

export function GraphPage({ doc, onStartQuiz, onNavigate }: GraphPageProps) {
  const { now, activeDocId } = useApp();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(null);
  }, [activeDocId]);

  const selectedNode = useMemo(() => {
    if (!doc || !selectedId) {
      return null;
    }
    return doc.nodes.find((node) => node.id === selectedId) ?? null;
  }, [doc, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('.modal-backdrop')) {
        setSelectedId(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedId]);

  if (!doc) {
    return (
      <div className="page">
        <div className="api-page">
          <div className="api-panel glass-panel" style={{ textAlign: 'center' }}>
            <p className="eyebrow">NO MATERIAL YET</p>
            <h1 style={{ fontFamily: 'var(--font-serif)', margin: '12px 0' }}>
              还没有可探索的材料
            </h1>
            <p style={{ color: 'var(--text-soft)', fontSize: 13 }}>
              回到首页，粘贴一段讲义或体验示例空间。
            </p>
            <button
              type="button"
              className="glass-button"
              style={{ marginTop: 22 }}
              onClick={() => onNavigate('home')}
            >
              回到首页
            </button>
          </div>
        </div>
      </div>
    );
  }

  const traceable = doc.nodes.filter((node) => node.quoteStart >= 0).length;
  const dueCount = doc.nodes.filter((node) => isDue(node.nextReviewAt, now)).length;

  return (
    <div className="graph-page">
      <header className="graph-head">
        <div className="graph-head__title">
          <div className="graph-head__meta">
            <span className="origin-badge">
              <BookOpen size={10} />
              {ORIGIN_LABEL[doc.origin]}
            </span>
            {doc.origin === 'demo' && (
              <>
                <span className="demo-notice">
                  <Info size={11} />
                  {DEMO_NOTICE}
                </span>
              </>
            )}
            <span>{dueCount} 个节点今天到期</span>
          </div>
          <h2>{doc.title}</h2>
        </div>

        <div className="graph-head__right">
          <div className="graph-stats" aria-label="文档统计">
            <div className="stat">
              <strong className="stat__value">{doc.nodes.length}</strong>
              <span className="stat__label">概念</span>
            </div>
            <div className="stat">
              <strong className="stat__value">{countRelations(doc)}</strong>
              <span className="stat__label">关联</span>
            </div>
            <div className="stat">
              <strong className="stat__value">
                {traceable}/{doc.nodes.length}
              </strong>
              <span className="stat__label">可溯源</span>
            </div>
          </div>
          <TimeTravel compact />
        </div>
      </header>

      <div className="graph-body">
        <KnowledgeGraph
          doc={doc}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onExport={() => downloadMarkdown(doc, now)}
        />
        {selectedNode && (
          <SourcePanel
            doc={doc}
            node={selectedNode}
            onClose={() => setSelectedId(null)}
            onQuiz={() => onStartQuiz([selectedNode.id])}
          />
        )}
      </div>
    </div>
  );
}
