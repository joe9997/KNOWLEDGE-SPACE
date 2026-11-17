import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  Info,
  Loader2,
  PlugZap,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { LiquidButton } from '../components/ui/LiquidButton';
import { testConnection, validateApiConfig } from '../lib/llm';
import { testServerConnection } from '../lib/serverAi';
import type { ApiConfig } from '../lib/types';
import { useApp } from '../state/AppStore';

const PROVIDERS = [
  {
    id: 'openai',
    label: 'OpenAI（兼容接口）',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek（兼容接口）',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容服务',
    baseUrl: '',
    model: '',
  },
];

interface Feedback {
  kind: 'success' | 'error' | 'info';
  message: string;
}

export function ApiConfigPage() {
  const { apiConfig, apiReady, updateApiConfig, serverAi, refreshServerAi } = useApp();
  const initial = apiConfig ?? {
    provider: 'openai',
    apiKey: '',
    baseUrl: PROVIDERS[0].baseUrl,
    model: PROVIDERS[0].model,
  };
  const [provider, setProvider] = useState(initial.provider);
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [model, setModel] = useState(initial.model);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [serverTesting, setServerTesting] = useState(false);
  const [serverFeedback, setServerFeedback] = useState<Feedback | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof ApiConfig, string>>>({});

  const currentConfig: ApiConfig = { provider, apiKey, baseUrl, model };

  const applyProvider = (id: string) => {
    const preset = PROVIDERS.find((item) => item.id === id);
    setProvider(id);
    if (preset && preset.id !== 'custom') {
      setBaseUrl(preset.baseUrl);
      setModel(preset.model);
    } else if (preset) {
      setBaseUrl('');
      setModel('');
    }
    setErrors({});
    setFeedback(null);
  };

  const validate = (): boolean => {
    const result = validateApiConfig(currentConfig);
    setErrors(result.errors);
    if (!result.ok) {
      setFeedback({ kind: 'error', message: '配置不完整，请先修正下方标出的字段。' });
    }
    return result.ok;
  };

  const handleTest = async () => {
    if (!validate()) {
      return;
    }
    setTesting(true);
    setFeedback(null);
    try {
      const result = await testConnection(currentConfig);
      setFeedback({ kind: 'success', message: `${result.message} 尚未保存，可继续测试或保存配置。` });
    } catch (error) {
      setFeedback({
        kind: 'error',
        message: `连接失败：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleServerTest = async () => {
    setServerTesting(true);
    setServerFeedback(null);
    try {
      const result = await testServerConnection();
      setServerFeedback({ kind: 'success', message: result.message });
    } catch (error) {
      setServerFeedback({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setServerTesting(false);
      await refreshServerAi();
    }
  };

  const saveConfig = () => {
    if (!validate()) {
      return;
    }
    updateApiConfig(currentConfig);
    setFeedback({
      kind: 'success',
      message: '配置已保存到当前标签页的 sessionStorage。刷新页面仍可用，关闭标签页即清除。',
    });
  };

  const handleSave = (event: FormEvent) => {
    event.preventDefault();
    saveConfig();
  };

  const handleClear = () => {
    updateApiConfig(null);
    setApiKey('');
    setFeedback({
      kind: 'info',
      message: '已清除当前标签页的 API 配置，回源回到本地规则整理模式。',
    });
  };

  return (
    <div className="api-page">
      <section className="api-panel glass-panel">
        <div className="api-panel__head">
          <p className="eyebrow">BRING YOUR OWN KEY</p>
          <h1>接入 API</h1>
          <p>
            接入你自己的 OpenAI 兼容模型服务。配置完成后，回源会在整理材料与生成节点时发起真实请求；
            未配置时，仍然可以使用本地规则整理，不调用任何 AI。
          </p>
          <div className="config-state" style={{ marginTop: 12 }}>
            <span className={`config-state__dot ${apiReady ? 'is-ready' : ''}`} />
            {apiReady ? `当前已保存 · ${apiConfig?.model}` : '当前未保存配置 · 本地体验'}
          </div>
        </div>

        <div className="server-ai">
          <div className="server-ai__head">
            <Server size={15} aria-hidden="true" />
            <strong>服务端 AI</strong>
            <span className="config-state">
              <span className={`config-state__dot ${serverAi?.available ? 'is-ready' : ''}`} />
              {serverAi === null
                ? '正在检测…'
                : !serverAi.reachable
                  ? '未连接后端'
                  : serverAi.available
                    ? `已启用 · ${serverAi.model}`
                    : '已连接 · 未配置 Key'}
            </span>
            <button
              type="button"
              className="glass-button glass-button--quiet"
              onClick={handleServerTest}
              disabled={serverTesting}
            >
              {serverTesting ? (
                <Loader2 size={14} className="spinner" />
              ) : (
                <PlugZap size={14} />
              )}
              {serverTesting ? '正在测试…' : serverAi?.available ? '测试服务端连接' : '重新检测'}
            </button>
          </div>
          <p className="field__hint">
            {serverAi === null
              ? '正在检测本地后端…'
              : !serverAi.reachable
                ? '未检测到本地后端。运行 npm run dev:server（或 npm run dev:all）后点击「重新检测」；也可以继续使用下方自带 Key 模式。'
                : serverAi.available
                  ? 'AI 整理会优先经后端调用模型：API Key 只保存在服务端 .env，不进入浏览器，也不受目标服务的 CORS 限制。'
                  : '后端已连接，但 .env 未配置 LLM_API_KEY（或缺少 LLM_BASE_URL / LLM_MODEL），填写后重启后端即可启用。'}
          </p>
          {serverFeedback && (
            <div
              className={`form-message is-${serverFeedback.kind}`}
              role="status"
              aria-live="polite"
            >
              {serverFeedback.kind === 'success' && <CheckCircle2 size={15} />}
              {serverFeedback.kind === 'error' && <AlertTriangle size={15} />}
              {serverFeedback.kind === 'info' && <Info size={15} />}
              <span>{serverFeedback.message}</span>
            </div>
          )}
        </div>

        <div className="security-note">
          <ShieldCheck size={15} aria-hidden="true" />
          <p>
            下方是「自带 Key」模式：密钥和材料由浏览器直接发送到你填写的模型服务，Key 只保存在当前标签页的
            sessionStorage，关闭即清除，不写入源码或 localStorage。若上方服务端 AI 已启用，AI
            整理会优先走本地后端，不读取这里的 Key；浏览器直连仍可能受目标服务 CORS 限制。
          </p>
        </div>

        <form onSubmit={handleSave} noValidate>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="api-provider">模型服务</label>
              <div className="field__control">
                <select
                  id="api-provider"
                  value={provider}
                  onChange={(event) => applyProvider(event.target.value)}
                >
                  {PROVIDERS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <span className="field__select-arrow">
                  <ChevronDown size={14} />
                </span>
              </div>
            </div>

            <div className="field">
              <label htmlFor="api-model">模型名称</label>
              <input
                id="api-model"
                value={model}
                onChange={(event) => {
                  setModel(event.target.value);
                  setErrors((prev) => ({ ...prev, model: undefined }));
                }}
                placeholder="例如 gpt-4o-mini"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(errors.model)}
              />
              {errors.model && <span className="field__error">{errors.model}</span>}
            </div>

            <div className="field field--full">
              <label htmlFor="api-key">API Key</label>
              <div className="field__control">
                <input
                  id="api-key"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setErrors((prev) => ({ ...prev, apiKey: undefined }));
                  }}
                  placeholder="sk-..."
                  autoComplete="new-password"
                  spellCheck={false}
                  aria-invalid={Boolean(errors.apiKey)}
                  style={{ paddingRight: 44 }}
                />
                <span className="field__suffix">
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setShowKey((value) => !value)}
                    aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                    title={showKey ? '隐藏密钥' : '显示密钥'}
                  >
                    {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </span>
              </div>
              {errors.apiKey && <span className="field__error">{errors.apiKey}</span>}
            </div>

            <div className="field field--full">
              <label htmlFor="api-base">接口 Base URL</label>
              <input
                id="api-base"
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setErrors((prev) => ({ ...prev, baseUrl: undefined }));
                }}
                placeholder="https://api.example.com/v1"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(errors.baseUrl)}
              />
              {errors.baseUrl ? (
                <span className="field__error">{errors.baseUrl}</span>
              ) : (
                <span className="field__hint">
                  测试连接请求 <code>{`${baseUrl.replace(/\/+$/, '') || 'https://…/v1'}/models`}</code>
                  ，生成节点请求 <code>/chat/completions</code>。
                </span>
              )}
            </div>
          </div>

          {feedback && (
            <div className={`form-message is-${feedback.kind}`} role="status" aria-live="polite">
              {feedback.kind === 'success' && <CheckCircle2 size={15} />}
              {feedback.kind === 'error' && <AlertTriangle size={15} />}
              {feedback.kind === 'info' && <Info size={15} />}
              <span>{feedback.message}</span>
            </div>
          )}

          <div className="form-actions">
            <button
              type="button"
              className="glass-button"
              onClick={handleTest}
              disabled={testing}
            >
              {testing ? <Loader2 size={15} className="spinner" /> : <PlugZap size={15} />}
              {testing ? '正在测试连接…' : '测试连接'}
            </button>
            <LiquidButton width={148} height={46} onClick={saveConfig} ariaLabel="保存配置">
              保存配置
            </LiquidButton>
            <span className="form-actions__spacer" />
            {apiConfig && (
              <button
                type="button"
                className="glass-button glass-button--quiet"
                onClick={handleClear}
              >
                <Trash2 size={14} />
                清除本页配置
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
