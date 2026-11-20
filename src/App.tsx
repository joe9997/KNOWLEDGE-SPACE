import { useCallback, useEffect, useState } from 'react';
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
import { ReviewPage } from './pages/ReviewPage';
import { SettingsPage } from './pages/SettingsPage';
import type { SettingsSection } from './pages/SettingsPage';
import type { QuizMode } from './lib/quizBank';
import type { AppView } from './lib/types';
import { useMediaQuery } from './lib/useMediaQuery';
import { useApp } from './state/AppStore';

export default function App() {
  const {
    docs,
    activeDoc,
    activeDocId,
    resetDemo,
    setActiveDocId,
    currentUser,
    authLoading,
    learningPrefs,
  } = useApp();
  const isMobile = useMediaQuery('(max-width: 900px)');
  const [view, setView] = useState<AppView>('home');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [quizSession, setQuizSession] = useState<{
    queue: string[];
    mode: QuizMode | null;
  } | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  // 每次点击「AI 助手」都换一个 token，助手页据此开启新会话
  const [assistantSession, setAssistantSession] = useState(0);
  // hub：侧栏入口，接入全部会话；doc：图谱页入口，只针对当前材料
  const [assistantMode, setAssistantMode] = useState<'hub' | 'doc'>('hub');
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

  const openReview = useCallback(() => {
    setSidebarOpen(false);
    navigate('review');
  }, [navigate]);

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
          onOpenAssistant={() => {
            setAssistantMode('hub');
            setAssistantSession((token) => token + 1);
            navigate('assistant');
          }}
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
                onStartReview={() => navigate('review')}
              />
            )}

            {view === 'graph' && (
              <GraphPage
                doc={activeDoc}
                onStartQuiz={(nodeIds) => setQuizSession({ queue: nodeIds, mode: 'self' })}
                onOpenQuizBank={(nodeIds) =>
                  setQuizSession({
                    queue: nodeIds,
                    mode: learningPrefs.quizMode === 'ask' ? null : learningPrefs.quizMode,
                  })
                }
                onNavigate={navigate}
                onOpenAssistant={() => {
                  setAssistantMode('doc');
                  setAssistantSession((token) => token + 1);
                  navigate('assistant');
                }}
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

            {view === 'review' && <ReviewPage />}

            {view === 'settings' && <SettingsPage initialSection={settingsSection} />}

            {view === 'assistant' && (
              <AssistantChat
                variant="page"
                open
                doc={activeDoc}
                docs={docs}
                mode={assistantMode}
                sessionToken={assistantSession}
                onStartQuiz={() => {
                  if (activeDoc) {
                    setQuizSession({ queue: activeDoc.nodes.map((node) => node.id), mode: null });
                  }
                }}
                onClose={() => navigate('graph')}
              />
            )}
          </div>
        </main>
      </div>

      <QuizModal
        open={quizSession !== null}
        doc={activeDoc}
        queue={quizSession?.queue ?? []}
        initialMode={quizSession?.mode ?? null}
        onClose={() => setQuizSession(null)}
      />

      <AssistantChat
        open={assistantOpen}
        doc={activeDoc}
        docs={docs}
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
