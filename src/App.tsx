import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { StarfieldBackground } from './components/background/StarfieldBackground';
import { AuthModal } from './components/auth/AuthModal';
import { AssistantChat } from './components/assistant/AssistantChat';
import { Sidebar } from './components/layout/Sidebar';
import { TopBar } from './components/layout/TopBar';
import { QuizModal } from './components/quiz/QuizModal';
import { GraphPage } from './pages/GraphPage';
import { HomePage } from './pages/HomePage';
import { NewSessionPage } from './pages/NewSessionPage';
import { SettingsPage } from './pages/SettingsPage';
import type { SettingsSection } from './pages/SettingsPage';
import { isDue } from './lib/review';
import type { AppView } from './lib/types';
import { useMediaQuery } from './lib/useMediaQuery';
import { useApp } from './state/AppStore';

export default function App() {
  const { activeDoc, activeDocId, now, resetDemo, setActiveDocId, currentUser, authLoading } =
    useApp();
  const isMobile = useMediaQuery('(max-width: 900px)');
  const [view, setView] = useState<AppView>('home');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [quizQueue, setQuizQueue] = useState<string[] | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('user');

  const navigate = useCallback((next: AppView) => {
    setView(next);
    setSidebarOpen(false);
    setAssistantOpen(false);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  const openDoc = useCallback(
    (id: string) => {
      setActiveDocId(id);
      navigate('graph');
    },
    [navigate, setActiveDocId],
  );

  const openNewSession = useCallback(() => {
    setSidebarOpen(false);
    navigate('new');
  }, [navigate]);

  const dueNodeIds = useMemo(() => {
    if (!activeDoc) {
      return [];
    }
    return activeDoc.nodes
      .filter((node) => isDue(node.nextReviewAt, now))
      .sort((a, b) => a.nextReviewAt - b.nextReviewAt)
      .map((node) => node.id);
  }, [activeDoc, now]);

  const openReview = useCallback(() => {
    setSidebarOpen(false);
    setQuizQueue(dueNodeIds);
  }, [dueNodeIds]);

  useEffect(() => {
    if (!isMobile) {
      setSidebarOpen(false);
    }
  }, [isMobile]);

  useEffect(() => {
    if (!assistantOpen) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAssistantOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [assistantOpen]);

  useEffect(() => {
    document.body.classList.toggle('drawer-open', isMobile && sidebarOpen);
    if (!isMobile || !sidebarOpen) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSidebarOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isMobile, sidebarOpen]);

  // 在移动端关闭抽屉时把焦点还给页面，避免焦点滞留在隐藏区域
  useEffect(() => {
    if (isMobile && !sidebarOpen) {
      const active = document.activeElement as HTMLElement | null;
      if (active && active.closest('.sidebar')) {
        active.blur();
      }
    }
  }, [isMobile, sidebarOpen]);

  if (authLoading) {
    return (
      <div className="app">
        <StarfieldBackground />
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="app">
        <StarfieldBackground />
        <AuthModal />
      </div>
    );
  }

  return (
    <div className="app">
      <StarfieldBackground />

      <div className="app-shell">
        <Sidebar
          view={view}
          isMobile={isMobile}
          mobileOpen={sidebarOpen}
          onCloseMobile={() => setSidebarOpen(false)}
          onNavigate={navigate}
          onNewSession={openNewSession}
          onOpenReview={openReview}
          onOpenDoc={openDoc}
        />

        <main className="app-main" inert={isMobile && sidebarOpen}>
          <TopBar
            view={view}
            onNavigate={navigate}
            onOpenSidebar={() => setSidebarOpen(true)}
          />

          <div className="page" key={view}>
            {view === 'home' && (
              <HomePage
                onNewSession={openNewSession}
                onOpenDemo={() => {
                  resetDemo();
                  navigate('graph');
                }}
                onOpenGraph={() => {
                  if (activeDocId) {
                    navigate('graph');
                  } else {
                    openNewSession();
                  }
                }}
                onStartReview={(nodeIds) => setQuizQueue(nodeIds)}
              />
            )}

            {view === 'graph' && (
              <GraphPage
                doc={activeDoc}
                onStartQuiz={(nodeIds) => setQuizQueue(nodeIds)}
                onNavigate={navigate}
              />
            )}

            {view === 'new' && (
              <NewSessionPage
                onCreated={(id) => {
                  setActiveDocId(id);
                  navigate('graph');
                }}
                onOpenApi={() => {
                  setSettingsSection('api');
                  navigate('settings');
                }}
              />
            )}

            {view === 'settings' && <SettingsPage initialSection={settingsSection} />}

            {view === 'assistant' && (
              <AssistantChat
                variant="page"
                open
                doc={null}
                onClose={() => navigate('graph')}
              />
            )}
          </div>
        </main>
      </div>

      <QuizModal
        open={quizQueue !== null}
        doc={activeDoc}
        queue={quizQueue ?? []}
        onClose={() => setQuizQueue(null)}
      />

      <AssistantChat
        open={assistantOpen}
        doc={activeDoc}
        onClose={() => setAssistantOpen(false)}
      />

      {view === 'graph' && activeDoc && !(isMobile && sidebarOpen) && (
        <button
          type="button"
          className={`assistant-fab ${assistantOpen ? 'is-open' : ''}`.trim()}
          onClick={() => setAssistantOpen((open) => !open)}
          aria-label="AI 助手"
          aria-expanded={assistantOpen}
          title="AI 助手"
        >
          <Sparkles size={21} />
        </button>
      )}
    </div>
  );
}
