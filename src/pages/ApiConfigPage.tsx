import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  Info,
  Loader2,
  PlugZap,
  Save,
  Server,
  Trash2,
} from 'lucide-react';
import { testConnection, validateApiConfig } from '../lib/llm';
import { testServerConnection } from '../lib/serverAi';
import type { ApiConfig } from '../lib/types';
import { useApp } from '../state/AppStore';

interface ProviderOption {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
}

const PROVIDERS: ProviderOption[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'qwen',
    label: '通义千问 · 阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4-long'],
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  {
    id: 'hunyuan',
    label: '腾讯混元',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: ['hunyuan-turbos-latest', 'hunyuan-pro', 'hunyuan-lite'],
  },
  {
    id: 'qianfan',
    label: '百度千帆 · 文心一言',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    models: ['ernie-4.5-turbo-128k', 'ernie-4.0-8k'],
  },
  {
    id: 'doubao',
    label: '火山方舟 · 豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [],
  },
  {
    id: 'openai',
    label: 'OpenAI（兼容接口）',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  },
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容服务',
    baseUrl: '',
    models: [],
  },
];

const CUSTOM_PROVIDER = PROVIDERS[PROVIDERS.length - 1];

interface Feedback {
  kind: 'success' | 'error' | 'info';
  message: string;
}

interface SelectOption {
  id: string;
  label: string;
}

interface GlassSelectProps {
  id?: string;
  value: string;
  options: SelectOption[];
  onChange: (id: string) => void;
  ariaLabel: string;
  menuLabel: string;
}

function GlassSelect({ id, value, options, onChange, ariaLabel, menuLabel }: GlassSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(
    0,
    options.findIndex((item) => item.id === value),
  );
  const selected = options[selectedIndex] ?? options[0];

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', closeOnOutside);
    return () => document.removeEventListener('mousedown', closeOnOutside);
  }, [open]);

  const openMenu = () => {
    setActiveIndex(selectedIndex);
    setOpen(true);
  };

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        break;
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % options.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + options.length) % options.length);
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        choose(options[activeIndex].id);
        break;
      default:
        break;
    }
  };

  return (
    <div className="glass-select" ref={rootRef}>
      <button
        type="button"
        id={id}
        className="glass-select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${ariaLabel}：${selected?.label ?? ''}`}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
      >
        <span>{selected?.label ?? ''}</span>
        <ChevronDown size={14} className="glass-select__chevron" aria-hidden="true" />
      </button>

      {open && (
        <ul
          className="glass-select__menu"
          role="listbox"
          aria-label={menuLabel}
          aria-activedescendant={`${id ?? 'select'}-option-${options[activeIndex]?.id ?? ''}`}
        >
          {options.map((item, index) => (
            <li
              key={item.id}
              id={`${id ?? 'select'}-option-${item.id}`}
              role="option"
              aria-selected={item.id === value}
              className={[
                'glass-select__option',
                index === activeIndex ? 'is-active' : '',
                item.id === value ? 'is-selected' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(item.id)}
            >
              <span>{item.label}</span>
              {item.id === value && <Check size={13} aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ApiConfigPage() {
  const { apiConfig, apiReady, updateApiConfig, serverAi, refreshServerAi } = useApp();
  const savedProvider =
    PROVIDERS.find((item) => item.id === apiConfig?.provider) ?? PROVIDERS[0];
  const initial = apiConfig ?? {
    provider: savedProvider.id,
    apiKey: '',
    baseUrl: savedProvider.baseUrl,
    model: savedProvider.models[0] ?? '',
  };
  const [provider, setProvider] = useState(initial.provider);
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [model, setModel] = useState(initial.model);
  const [customModel, setCustomModel] = useState(
    savedProvider.models.length > 0 && !savedProvider.models.includes(initial.model),
  );
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [serverTesting, setServerTesting] = useState(false);
  const [serverFeedback, setServerFeedback] = useState<Feedback | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof ApiConfig, string>>>({});

  const currentConfig: ApiConfig = { provider, apiKey, baseUrl, model };
  const preset = PROVIDERS.find((item) => item.id === provider) ?? CUSTOM_PROVIDER;
  const providerOptions = PROVIDERS.map((item) => ({ id: item.id, label: item.label }));
  const CUSTOM_MODEL_ID = '__custom-model__';
  const modelOptions = [
    ...preset.models.map((item) => ({ id: item, label: item })),
    ...(preset.models.length > 0 ? [{ id: CUSTOM_MODEL_ID, label: '自定义模型…' }] : []),
  ];

  const applyProvider = (id: string) => {
    const next = PROVIDERS.find((item) => item.id === id) ?? CUSTOM_PROVIDER;
    setProvider(next.id);
    setBaseUrl(next.baseUrl);
    setModel(next.models[0] ?? '');
    setCustomModel(false);
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
                  ? 'AI 整理会优先经后端调用模型：API Key 只保存在服务端，不进入浏览器，也不受目标服务的 CORS 限制。'
                  : '后端已连接，但尚未配置 AI。你可以在下方填写自己的 API Key，AI 助手会优先使用它。'}
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

        <form onSubmit={handleSave} noValidate>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="api-provider">模型服务</label>
              <GlassSelect
                id="api-provider"
                value={provider}
                options={providerOptions}
                onChange={applyProvider}
                ariaLabel="模型服务"
                menuLabel="模型服务"
              />
            </div>

            <div className="field">
              <label htmlFor="api-model">模型名称</label>
              {preset.models.length > 0 && !customModel ? (
                <GlassSelect
                  id="api-model"
                  value={model}
                  options={modelOptions}
                  onChange={(id) => {
                    setErrors((prev) => ({ ...prev, model: undefined }));
                    if (id === '__custom-model__') {
                      setCustomModel(true);
                      return;
                    }
                    setModel(id);
                  }}
                  ariaLabel="模型"
                  menuLabel="模型"
                />
              ) : (
                <input
                  id="api-model"
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value);
                    setErrors((prev) => ({ ...prev, model: undefined }));
                  }}
                  placeholder={
                    provider === 'doubao'
                      ? '填写接入点 ID（ep-xxx）'
                      : '例如 gpt-4o-mini 或自定义模型名'
                  }
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(errors.model)}
                />
              )}
              {preset.models.length > 0 && (
                <span className="field__hint">
                  {customModel ? (
                    <button
                      type="button"
                      className="field__link"
                      onClick={() => {
                        setCustomModel(false);
                        setModel(preset.models[0] ?? '');
                      }}
                    >
                      返回预设模型列表
                    </button>
                  ) : (
                    '也可以选择「自定义模型…」手动填写模型名'
                  )}
                </span>
              )}
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
            <button type="submit" className="glass-button">
              <Save size={15} />
              保存配置
            </button>
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
