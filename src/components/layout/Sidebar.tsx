import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarCheck2, Plus, Search, Settings2, X } from 'lucide-react';
import { OrbitMark } from '../OrbitMark';
import { isDue } from '../../lib/review';
import type { AppView, KnowledgeDoc } from '../../lib/types';
import { useApp } from '../../state/AppStore';

interface SidebarProps {
  view: AppView;
  isMobile: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onNavigate: (view: AppView) => void;
  onNewSession: () => void;
  onOpenReview: () => void;
  onOpenDoc: (id: string) => void;
}

function dueCount(doc: KnowledgeDoc, now: number): number {
  return doc.nodes.filter((node) => isDue(node.nextReviewAt, now)).length;
}

export function Sidebar({
  view,
  isMobile,
  mobileOpen,
  onCloseMobile,
  onNavigate,
  onNewSession,
  onOpenReview,
  onOpenDoc,
}: SidebarProps) {
  const { docs, activeDoc, activeDocId, now, setActiveDocId, apiReady } = useApp();
  const [query, setQuery] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isMobile || !mobileOpen) {
      return;
    }
    const timer = window.setTimeout(() => closeRef.current?.focus(), 120);
    return () => window.clearTimeout(timer);
  }, [isMobile, mobileOpen]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return docs;
    }
    return docs.filter(
      (doc) =>
        doc.title.toLowerCase().includes(keyword) ||
        doc.nodes.some((node) => node.title.toLowerCase().includes(keyword)),
    );
  }, [docs, query]);

  const activeDue = activeDoc ? dueCount(activeDoc, now) : 0;

  return (
    <>
      {isMobile && mobileOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="关闭侧栏"
          onClick={onCloseMobile}
        />
      )}
      <aside
        className={`sidebar glass-panel ${isMobile && mobileOpen ? 'is-open' : ''}`.trim()}
        aria-label="会话与导航"
        inert={isMobile && !mobileOpen}
        aria-hidden={isMobile && !mobileOpen}
      >
        <div className="sidebar__brand">
          <OrbitMark size={38} />
          <div className="sidebar__brand-text">
            <h1>回源</h1>
            <p>KNOWLEDGE SPACE</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-button sidebar__close"
            onClick={onCloseMobile}
            aria-label="关闭侧栏"
          >
            <X size={17} />
          </button>
        </div>

        <button
          type="button"
          className="new-session-button"
          onClick={onNewSession}
          aria-label="新建会话"
        >
          <Plus size={16} strokeWidth={2} aria-hidden="true" />
          新会话
        </button>

        <label className="search-field">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话或概念"
            aria-label="搜索会话或概念"
          />
        </label>

        <div className="sidebar__section-head">
          <span>最近会话</span>
          <span>{filtered.length}</span>
        </div>

        <nav className="session-list" aria-label="最近会话">
          {filtered.map((doc) => {
            const due = dueCount(doc, now);
            const active = doc.id === activeDocId && view !== 'api' && view !== 'new';
            return (
              <button
                key={doc.id}
                type="button"
                className={`session-item ${active ? 'is-active' : ''}`.trim()}
                onClick={() => {
                  setActiveDocId(doc.id);
                  onOpenDoc(doc.id);
                  if (isMobile) {
                    onCloseMobile();
                  }
                }}
                aria-current={active ? 'page' : undefined}
              >
                <span className="session-item__title">
                  <span>{doc.title}</span>
                  {doc.origin === 'demo' && <span className="demo-tag">体验</span>}
                </span>
                <span className="session-item__meta">
                  {doc.nodes.length} 节点 · {due > 0 ? <em>{due} 待复习</em> : '0 待复习'}
                </span>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <p className="session-list__empty">
              没有匹配「{query}」的会话。
              <br />
              可以新建一段材料，让知识重新长出来。
            </p>
          )}
        </nav>

        <div className="sidebar__footer">
          <button type="button" className="review-entry" onClick={onOpenReview}>
            <span className="review-entry__icon">
              <CalendarCheck2 size={15} />
            </span>
            <span className="review-entry__text">
              <strong>今日复习</strong>
              <span>{activeDue > 0 ? '按到期顺序逐个复习' : '暂无到期节点'}</span>
            </span>
            <span className="review-entry__count">{activeDue}</span>
          </button>

          <div className="sidebar__user">
            <span className="avatar" aria-hidden="true">
              回
            </span>
            <div className="sidebar__user-text">
              <strong>本地学习者</strong>
              <span>{apiReady ? '已配置 API · 仅存本标签页' : '本地体验 · 数据留在浏览器'}</span>
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                onNavigate('api');
                if (isMobile) {
                  onCloseMobile();
                }
              }}
              aria-label="API 设置"
              title="API 设置"
            >
              <Settings2 size={15} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
