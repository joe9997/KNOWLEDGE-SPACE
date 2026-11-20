import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { CalendarCheck2, LogOut, Pencil, Plus, Search, Settings2, Sparkles, Trash2, X } from 'lucide-react';
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
  onOpenAssistant: () => void;
  onOpenReview: () => void;
  onOpenDoc: (id: string) => void;
}

function dueCount(doc: KnowledgeDoc, now: number): number {
  return doc.nodes.filter((node) => isDue(node.nextReviewAt, now)).length;
}

interface SessionMenuState {
  docId: string;
  x: number;
  y: number;
}

export function Sidebar({
  view,
  isMobile,
  mobileOpen,
  onCloseMobile,
  onNavigate,
  onNewSession,
  onOpenAssistant,
  onOpenReview,
  onOpenDoc,
}: SidebarProps) {
  const { docs, activeDoc, activeDocId, now, setActiveDocId, renameDoc, deleteDoc, currentUser, logout } =
    useApp();
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<SessionMenuState | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
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

  const closeMenu = () => {
    setMenu(null);
    setConfirmDeleteId(null);
  };

  const openMenu = (event: ReactMouseEvent, docId: string) => {
    event.preventDefault();
    setMenu({
      docId,
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 120),
    });
    setConfirmDeleteId(null);
  };

  useEffect(() => {
    if (!menu) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(null);
        setConfirmDeleteId(null);
      }
    };
    const onViewportChange = () => {
      setMenu(null);
      setConfirmDeleteId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [menu]);

  const startRename = (doc: KnowledgeDoc) => {
    setRenamingId(doc.id);
    setRenameValue(doc.title);
    closeMenu();
  };

  const commitRename = () => {
    if (renamingId) {
      renameDoc(renamingId, renameValue);
    }
    setRenamingId(null);
  };

  const menuDoc = menu ? docs.find((doc) => doc.id === menu.docId) : undefined;

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
            const active = doc.id === activeDocId && view === 'graph';
            if (renamingId === doc.id) {
              return (
                <div key={doc.id} className="session-item is-editing">
                  <input
                    className="session-item__rename"
                    value={renameValue}
                    autoFocus
                    aria-label="会话名称"
                    onChange={(event) => setRenameValue(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitRename();
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        setRenamingId(null);
                      }
                    }}
                  />
                  <span className="session-item__meta">回车保存 · Esc 取消</span>
                </div>
              );
            }
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
                onContextMenu={(event) => openMenu(event, doc.id)}
                title="右键管理会话"
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
          <button
            type="button"
            className={`assistant-entry ${view === 'assistant' ? 'is-active' : ''}`.trim()}
            onClick={() => {
              onOpenAssistant();
              if (isMobile) {
                onCloseMobile();
              }
            }}
            aria-current={view === 'assistant' ? 'page' : undefined}
          >
            <span className="assistant-entry__icon">
              <Sparkles size={15} />
            </span>
            <span className="assistant-entry__text">
              <strong>AI 助手</strong>
            </span>
          </button>

          <button
            type="button"
            className={`review-entry ${view === 'review' ? 'is-active' : ''}`.trim()}
            onClick={onOpenReview}
            aria-current={view === 'review' ? 'page' : undefined}
          >
            <span className="review-entry__icon">
              <CalendarCheck2 size={15} />
            </span>
            <span className="review-entry__text">
              <strong>今日复习</strong>
            </span>
            <span className="review-entry__count">{activeDue}</span>
          </button>

          <div className="sidebar__user-area">
            <button
              type="button"
              className="sidebar__user"
              onClick={() => {
                onNavigate('settings');
                if (isMobile) {
                  onCloseMobile();
                }
              }}
              title="用户设置"
            >
              <span className="avatar" aria-hidden="true">
                {currentUser?.avatar ? (
                  <img src={currentUser.avatar} alt={currentUser.username} />
                ) : (
                  (currentUser?.username ?? '回').slice(0, 1).toUpperCase()
                )}
              </span>
              <div className="sidebar__user-text">
                <strong>{currentUser?.username ?? '未登录'}</strong>
                <span>{currentUser?.email ?? '点击进入设置'}</span>
              </div>
            </button>

            <div className="sidebar__user-actions">
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  onNavigate('settings');
                  if (isMobile) {
                    onCloseMobile();
                  }
                }}
                aria-label="设置"
                title="设置"
              >
                <Settings2 size={15} />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  void logout();
                }}
                aria-label="退出登录"
                title="退出登录"
              >
                <LogOut size={15} />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {menu &&
        createPortal(
          <>
            <div
              className="session-menu-backdrop"
              onPointerDown={closeMenu}
              aria-hidden="true"
            />
            <div
              className="session-menu"
              style={{ left: menu.x, top: menu.y }}
              role="menu"
              aria-label={menuDoc ? `管理「${menuDoc.title}」` : '管理会话'}
            >
              <button
                type="button"
                role="menuitem"
                className="session-menu__item"
                onClick={() => {
                  if (menuDoc) {
                    startRename(menuDoc);
                  }
                }}
              >
                <Pencil size={14} />
                编辑名称
              </button>
              {confirmDeleteId === menu.docId ? (
                <button
                  type="button"
                  role="menuitem"
                  className="session-menu__item is-danger"
                  onClick={() => {
                    deleteDoc(menu.docId);
                    closeMenu();
                  }}
                >
                  <Trash2 size={14} />
                  确认删除
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="session-menu__item is-danger"
                  onClick={() => setConfirmDeleteId(menu.docId)}
                >
                  <Trash2 size={14} />
                  删除会话
                </button>
              )}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
