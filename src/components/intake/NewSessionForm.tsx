import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  AlignLeft,
  FileUp,
  Loader2,
  Sparkles,
  Upload,
} from 'lucide-react';
import { LiquidButton } from '../ui/LiquidButton';
import { extractLocally, toKnowledgeNodes } from '../../lib/localExtract';
import { extractFileText, FILE_ACCEPT } from '../../lib/fileText';
import { extractWithAI, type ExtractionProgress } from '../../lib/llm';
import { extractWithServer } from '../../lib/serverAi';
import { useApp } from '../../state/AppStore';

const MAX_CHARS = 20_000;

interface NewSessionFormProps {
  onCreated: (docId: string) => void;
  onOpenApi: () => void;
}

function deriveTitle(text: string): string {
  const heading = text.match(/^\s*#{1,6}\s+(.+)$/m);
  if (heading) {
    return heading[1].trim().slice(0, 40);
  }
  const firstLine = text.split('\n').find((line) => line.trim())?.trim() ?? '';
  return firstLine.replace(/^#{1,6}\s*/, '').slice(0, 28) || '未命名材料';
}

export function NewSessionForm({ onCreated, onOpenApi }: NewSessionFormProps) {
  const { apiReady, apiConfig, createDoc, serverAi, aiReady } = useApp();
  const viaServer = serverAi?.available === true;
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [working, setWorking] = useState<'file' | 'ai' | null>(null);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!titleTouched) {
      setTitle(text ? deriveTitle(text) : '');
    }
  }, [text, titleTouched]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const loadFile = async (file: File) => {
    if (file.size > 20 * 1024 * 1024) {
      setError(`${file.name} 超过 20MB，请先拆分或压缩后再导入。`);
      return;
    }
    setWorking('file');
    setError(null);
    try {
      const { text: content, chars, truncated } = await extractFileText(file, MAX_CHARS);
      if (!content.trim()) {
        setError('没有从文件中读到文字，请检查文件内容后重试。');
        return;
      }
      setText(content);
      if (!titleTouched) {
        setTitle(deriveTitle(content));
      }
      if (truncated) {
        setError(
          `文件共 ${chars.toLocaleString()} 字，已截取前 ${MAX_CHARS.toLocaleString()} 字导入。`,
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取文件失败，请重试。');
    } finally {
      setWorking(null);
    }
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) {
      void loadFile(file);
    }
  };

  const ensureText = (): boolean => {
    if (text.trim().length < 20) {
      setError('材料太短了，至少粘贴 20 个字才能整理出知识节点。');
      return false;
    }
    return true;
  };

  const handleLocal = () => {
    if (!ensureText()) {
      return;
    }
    setError(null);
    const extracted = extractLocally(text);
    const nodes = toKnowledgeNodes(extracted, text);
    if (nodes.length === 0) {
      setError('没有从这段材料中识别出可用节点，请检查文本结构后重试。');
      return;
    }
    onCreated(createDoc({ title: title || deriveTitle(text), text, origin: 'local', nodes }));
  };

  const handleAI = async () => {
    if (!ensureText()) {
      return;
    }
    if (!aiReady) {
      setError('还没有可用的模型服务。可以先使用本地规则整理，或前往「接入 API」完成配置。');
      return;
    }
    setWorking('ai');
    setError(null);
    setProgress({ done: 0, total: 1 });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const onProgress = (next: ExtractionProgress) => setProgress(next);
      let extracted;
      if (viaServer) {
        extracted = await extractWithServer(text, onProgress, controller.signal);
      } else if (apiConfig) {
        extracted = await extractWithAI(apiConfig, text, onProgress, controller.signal);
      } else {
        throw new Error('API 配置不完整，请前往「接入 API」补全后再试。');
      }
      const nodes = toKnowledgeNodes(extracted, text);
      if (nodes.length === 0) {
        throw new Error('模型返回了内容，但没有可用的节点。');
      }
      onCreated(createDoc({ title: title || deriveTitle(text), text, origin: 'ai', nodes }));
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      abortRef.current = null;
      setWorking(null);
    }
  };

  return (
    <>
      <div className="field" style={{ marginBottom: 16 }}>
        <label htmlFor="material-title">材料标题</label>
        <input
          id="material-title"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setTitleTouched(true);
          }}
          placeholder="例如：证据法讲义 · 证明责任"
          maxLength={60}
        />
      </div>

      <div
        className={`dropzone ${dragging ? 'is-dragging' : ''}`.trim()}
        role="button"
        tabIndex={0}
        aria-label="选择或拖入 PDF / Word / 文本文件"
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragging(false);
          }
        }}
        onDrop={handleDrop}
      >
        <span className="dropzone__icon">
          {working === 'file' ? <Loader2 size={16} className="spinner" /> : <FileUp size={17} />}
        </span>
        <span className="dropzone__text">
          {working === 'file' ? '正在读取文件…' : '拖入或选择文件'}
          <span>支持 PDF / Word / 文本 · 最多 20,000 字</span>
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept={FILE_ACCEPT}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void loadFile(file);
            }
            event.target.value = '';
          }}
        />
      </div>

      <div className="field">
        <label htmlFor="material-text">粘贴原文</label>
        <textarea
          id="material-text"
          className="intake-textarea"
          value={text}
          onChange={(event) => {
            const next = event.target.value;
            if (next.length > MAX_CHARS) {
              setText(next.slice(0, MAX_CHARS));
              setError('已达到 20,000 字上限，超出部分未导入。');
            } else {
              setText(next);
            }
          }}
          placeholder={'把讲义、笔记或文章粘贴到这里…\n\n# 一级标题\n每个标题下的第一句完整原句会成为节点的溯源引用。'}
          spellCheck={false}
          aria-describedby="material-counter"
        />
      </div>
      <div className="intake-meta" id="material-counter">
        <span>原文会完整保存在本浏览器，用于溯源高亮与导出。</span>
        <span>
          <strong className={text.length >= MAX_CHARS ? 'is-over' : ''}>
            {text.length.toLocaleString()}
          </strong>{' '}
          / 20,000 字
        </span>
      </div>

      {progress && working === 'ai' && (
        <div className="intake-progress" role="status" aria-live="polite">
          <Loader2 size={13} className="spinner" />
          正在调用模型抽取节点 · 已处理 {progress.done}/{progress.total} 块
        </div>
      )}

      {error && (
        <div className="form-message is-error" role="alert">
          <AlertTriangle size={15} />
          <span>{error}</span>
        </div>
      )}

      <div className="intake-actions">
        <span className="intake-api-hint">
          {viaServer ? (
            <>
              <Sparkles size={12} />
              服务端已托管 {serverAi?.model}，AI 整理经后端调用，Key 不进入浏览器
            </>
          ) : apiReady ? (
            <>
              <Sparkles size={12} />
              已配置 {apiConfig?.model}，AI 整理会由浏览器直连该服务
            </>
          ) : (
            <>
              <AlignLeft size={12} />
              本地体验 ·
              <button type="button" onClick={onOpenApi}>
                配置 API 后启用 AI 整理
              </button>
            </>
          )}
        </span>

        <button
          type="button"
          className="glass-button"
          onClick={handleLocal}
          disabled={working !== null || text.trim().length < 20}
        >
          <Upload size={14} />
          本地整理 · 不调用 AI
        </button>

        <LiquidButton
          width={166}
          height={46}
          onClick={handleAI}
          disabled={!aiReady || working !== null || text.trim().length < 20}
          ariaLabel="用 AI 整理材料"
        >
          {working === 'ai' ? (
            <>
              <Loader2 size={14} className="spinner" />
              整理中…
            </>
          ) : (
            <>
              <Sparkles size={14} />
              用 AI 整理
            </>
          )}
        </LiquidButton>
      </div>
    </>
  );
}
