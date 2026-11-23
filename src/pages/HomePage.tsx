import { useMemo } from 'react';
import { ArrowUpRight, Compass, Sparkles } from 'lucide-react';
import { OrbitMark } from '../components/OrbitMark';
import { TimeTravel } from '../components/TimeTravel';
import { LiquidButton } from '../components/ui/LiquidButton';
import { countRelations } from '../lib/exportMarkdown';
import { isDue, isSoon, STATUS_LABEL, statusOf } from '../lib/review';
import { useApp } from '../state/AppStore';

interface HomePageProps {
  onNewSession: () => void;
  onOpenDemo: () => void;
  onOpenGraph: () => void;
  onStartReview: (nodeIds: string[]) => void;
}

const HERO_TITLE = '让知识，有迹可循。';

export function HomePage({
  onNewSession,
  onOpenDemo,
  onOpenGraph,
  onStartReview,
}: HomePageProps) {
  const { activeDoc, now, docs } = useApp();

  const dueNodes = useMemo(() => {
    const out: Array<{ docId: string; node: typeof docs[number]['nodes'][number] }> = [];
    for (const doc of docs) {
      for (const node of doc.nodes) {
        if (node.mastery === 2) continue;
        if (isDue(node.nextReviewAt, now) || isSoon(node.nextReviewAt, now, 3)) {
          out.push({ docId: doc.id, node });
        }
      }
    }
    out.sort((a, b) => a.node.nextReviewAt - b.node.nextReviewAt);
    return out;
  }, [docs, now]);

  const traceable = activeDoc
    ? activeDoc.nodes.filter((node) => node.quoteStart >= 0).length
    : 0;

  return (
    <div className="home">
      <section className="hero">
        <OrbitMark size={62} className="hero__mark" />
        <p className="eyebrow hero__eyebrow">EVERY IDEA HAS AN ORIGIN</p>
        <h1 className="hero__title" aria-label={HERO_TITLE}>
          {Array.from(HERO_TITLE).map((char, index) => (
            <span
              key={`${char}-${index}`}
              className="hero__title-char"
              aria-hidden="true"
              style={{ animationDelay: `${index * 65}ms` }}
            >
              {char}
            </span>
          ))}
        </h1>
        <div className="hero__actions">
          <LiquidButton
            onClick={onNewSession}
            width={214}
            height={54}
            ariaLabel="开启新的探索"
            variant="contrast"
          >
            <Sparkles size={15} strokeWidth={1.7} />
            开启新的探索
          </LiquidButton>
          <button type="button" className="glass-button" onClick={onOpenDemo}>
            <Compass size={15} strokeWidth={1.7} />
            体验示例空间
          </button>
        </div>
      </section>

      <div className="home-cards">
        <section className="home-card glass-card" aria-labelledby="continue-title">
          <div className="home-card__head">
            <div>
              <p className="home-card__label">继续探索</p>
              <h2 id="continue-title" className="continue__title">
                {activeDoc ? activeDoc.title : '还没有开始一段材料'}
              </h2>
            </div>
            {activeDoc?.origin === 'demo' && (
              <span className="origin-badge">体验材料</span>
            )}
          </div>

          {activeDoc ? (
            <>
              <div className="continue__meta">
                <span>{activeDoc.nodes.length} 个知识节点</span>
                <span>{countRelations(activeDoc)} 条关联</span>
                <span>
                  可溯源 {traceable}/{activeDoc.nodes.length}
                </span>
              </div>
              <div className="continue__chips">
                {activeDoc.nodes.slice(0, 5).map((node) => (
                  <span key={node.id}>
                    <i
                      className="status-dot"
                      data-status={statusOf(node, now)}
                      aria-hidden="true"
                      style={{ width: 5, height: 5 }}
                    />
                    {node.title}
                  </span>
                ))}
                {activeDoc.nodes.length > 5 && <span>+{activeDoc.nodes.length - 5}</span>}
              </div>
              <div className="continue__footer">
                <p className="continue__progress">
                  <strong>{dueNodes.length}</strong>
                  今天到期 · 共 {docs.length} 段材料
                </p>
                <button type="button" className="glass-button" onClick={onOpenGraph}>
                  查看知识网络
                  <ArrowUpRight size={14} />
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="home-card__empty">
                粘贴一段讲义，或拖入 PDF / Word / PPT / 文本文件，回源会把它整理成可以点回原句的知识节点。
              </p>
              <div className="continue__footer">
                <button type="button" className="glass-button" onClick={onNewSession}>
                  开启新的探索
                  <ArrowUpRight size={14} />
                </button>
              </div>
            </>
          )}
        </section>

        <section className="home-card glass-card review-card" aria-labelledby="review-title">
          <div className="review-card__head">
            <div>
              <p className="home-card__label" id="review-title">
                今日待复习
              </p>
              <div className="review-card__count">
                <strong>{dueNodes.length}</strong>
                <span>个节点到期</span>
              </div>
            </div>
            <TimeTravel compact />
          </div>

          <ul className="review-list">
            {dueNodes.slice(0, 3).map(({ node, docId }) => {
              const doc = docs.find((d) => d.id === docId);
              const status = statusOf(node, now);
              return (
                <li className="review-list__item" key={`${docId}:${node.id}`}>
                  <i
                    className="status-dot"
                    data-status={status}
                    aria-hidden="true"
                  />
                  <span>{node.title}</span>
                  {doc?.title && <small className="review-list__doc">来自《{doc.title}》</small>}
                  <small>{STATUS_LABEL[status]}</small>
                </li>
              );
            })}
            {dueNodes.length === 0 && (
              <li className="review-empty">
                今天没有到期或临近的节点。
                <br />
                可以继续探索材料，或把时间拨到三天后看看。
              </li>
            )}
          </ul>

          <div className="review-card__footer">
            <span className="review-card__more">
              {dueNodes.length > 3
                ? `前 3 个优先，本轮共 ${dueNodes.length} 个`
                : '按到期顺序逐个自测'}
            </span>
            <button
              type="button"
              className="glass-button"
              onClick={() => onStartReview(dueNodes.map((item) => item.node.id))}
              disabled={dueNodes.length === 0}
            >
              逐个复习
              <ArrowUpRight size={14} />
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
