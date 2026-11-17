import { House, Menu } from 'lucide-react';
import type { AppView } from '../../lib/types';
import { useApp } from '../../state/AppStore';
import { OrbitMark } from '../OrbitMark';
import { ThemeToggle } from './ThemeToggle';

interface TopBarProps {
  view: AppView;
  onNavigate: (view: AppView) => void;
  onOpenSidebar: () => void;
}

const VIEW_LABEL: Record<AppView, string> = {
  home: '首页',
  new: '新建会话',
  graph: '知识网络',
  api: '接入 API',
};

export function TopBar({ view, onNavigate, onOpenSidebar }: TopBarProps) {
  const { activeDoc } = useApp();

  return (
    <header className="topbar">
      <div className="topbar__left">
        <button
          type="button"
          className="icon-button topbar__menu"
          onClick={onOpenSidebar}
          aria-label="打开侧栏"
        >
          <Menu size={18} />
        </button>
        <span className="topbar__mobile-brand">
          <OrbitMark size={22} />
          回源
        </span>
        <nav className="breadcrumb" aria-label="面包屑">
          <button
            type="button"
            className="icon-button topbar__home"
            onClick={() => onNavigate('home')}
            aria-label="返回首页"
            title="返回首页"
          >
            <House size={16} />
          </button>
          <span className="breadcrumb__sep" aria-hidden="true">
            /
          </span>
          {view === 'graph' && activeDoc ? (
            <>
              <span>知识网络</span>
              <span className="breadcrumb__sep" aria-hidden="true">
                /
              </span>
              <span className="breadcrumb__current">{activeDoc.title}</span>
            </>
          ) : (
            <span className="breadcrumb__current">{VIEW_LABEL[view]}</span>
          )}
        </nav>
      </div>

      <div className="topbar__actions">
        <ThemeToggle />
      </div>
    </header>
  );
}
