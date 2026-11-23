import { NewSessionForm } from '../components/intake/NewSessionForm';

interface NewSessionPageProps {
  onCreated: (docId: string) => void;
  onOpenApi: () => void;
}

export function NewSessionPage({ onCreated, onOpenApi }: NewSessionPageProps) {
  return (
    <div className="new-session-page">
      <section className="new-session-panel glass-panel">
        <header className="new-session-panel__head">
          <p className="eyebrow">NEW SESSION</p>
          <h1>开启新的探索</h1>
          <p>
            粘贴一段讲义，或拖入 PDF / Word / PPT / 文本文件。回源会保留完整原文，并为每个节点绑定可逐字核对的原句。
            未配置 API 时可使用本地规则整理，不调用任何 AI。
          </p>
        </header>
        <NewSessionForm onCreated={onCreated} onOpenApi={onOpenApi} />
      </section>
    </div>
  );
}
