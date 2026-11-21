import { useState } from 'react';
import type { FormEvent } from 'react';
import { Fingerprint, Loader2, Lock, Mail, UserRound } from 'lucide-react';
import { OrbitMark } from '../OrbitMark';
import { useApp } from '../../state/AppStore';
import { passkeySupported, STATIC_DEPLOY } from '../../lib/auth';

type Mode = 'login' | 'register';

export function AuthModal() {
  const { login, register, loginWithPasskey, backendAvailable, enterLocalMode } = useApp();
  const [mode, setMode] = useState<Mode>('login');
  const [identifier, setIdentifier] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canPasskey = passkeySupported();
  const offline = backendAvailable === false;

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setPassword('');
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause);
      setError(
        offline && /HTTP \d{3}/.test(raw)
          ? '账号服务器未连接，请使用下方「本地模式」直接开始。'
          : raw,
      );
    } finally {
      setBusy(false);
    }
  };

  const submitLogin = (event: FormEvent) => {
    event.preventDefault();
    if (!identifier.trim() || !password) {
      setError('请输入账号和密码');
      return;
    }
    void run(() => login(identifier.trim(), password));
  };

  const submitRegister = (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !username.trim() || !password) {
      setError('请填写邮箱、用户名和密码');
      return;
    }
    void run(() => register(email.trim(), username.trim(), password));
  };

  return (
    <div className="auth-overlay" role="dialog" aria-modal="true" aria-label="登录">
      <div className="auth-modal glass-panel">
        <div className="auth-modal__brand">
          <OrbitMark size={40} />
          <h1>回源</h1>
        </div>

        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            className={mode === 'login' ? 'is-active' : ''}
            onClick={() => switchMode('login')}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            className={mode === 'register' ? 'is-active' : ''}
            onClick={() => switchMode('register')}
          >
            注册
          </button>
        </div>

        {mode === 'login' ? (
          <form className="auth-form" onSubmit={submitLogin}>
            <label className="auth-field">
              <span>邮箱或用户名</span>
              <div className="auth-field__control">
                <UserRound size={15} />
                <input
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  placeholder="you@example.com 或 用户名"
                  autoComplete="username"
                  autoFocus
                />
              </div>
            </label>
            <label className="auth-field">
              <span>密码</span>
              <div className="auth-field__control">
                <Lock size={15} />
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="密码"
                  autoComplete="current-password"
                />
              </div>
            </label>

            {error && <p className="auth-error">{error}</p>}

            <button type="submit" className="auth-submit" disabled={busy}>
              {busy ? <Loader2 size={15} className="spinner" /> : null}
              {busy ? '正在登录…' : '登录'}
            </button>

            {canPasskey && (
              <button
                type="button"
                className="auth-passkey"
                disabled={busy}
                onClick={() => void run(loginWithPasskey)}
              >
                <Fingerprint size={16} />
                使用 Passkey 登录
              </button>
            )}
          </form>
        ) : (
          <form className="auth-form" onSubmit={submitRegister}>
            <label className="auth-field">
              <span>邮箱</span>
              <div className="auth-field__control">
                <Mail size={15} />
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoFocus
                />
              </div>
            </label>
            <label className="auth-field">
              <span>用户名</span>
              <div className="auth-field__control">
                <UserRound size={15} />
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="2–20 个字符"
                  autoComplete="username"
                />
              </div>
            </label>
            <label className="auth-field">
              <span>密码</span>
              <div className="auth-field__control">
                <Lock size={15} />
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="至少 8 位"
                  autoComplete="new-password"
                />
              </div>
            </label>

            {error && <p className="auth-error">{error}</p>}

            <button type="submit" className="auth-submit" disabled={busy}>
              {busy ? <Loader2 size={15} className="spinner" /> : null}
              {busy ? '正在注册…' : '注册'}
            </button>
          </form>
        )}

        {offline && (
          <p className="auth-offline">
            当前是纯静态部署，账号服务器未连接。你可以直接用本地模式，数据保存在这台设备的浏览器里。
          </p>
        )}

        <button
          type="button"
          className={`auth-local${offline ? ' is-primary' : ''}`}
          disabled={busy}
          onClick={enterLocalMode}
        >
          不登录，用本地模式
        </button>

        <p className="auth-footnote">
          {STATIC_DEPLOY
            ? '静态体验版：账号与数据仅保存在当前浏览器，换设备不会同步。'
            : '登录后即可使用，数据保存在你的账号下。'}
        </p>
      </div>
    </div>
  );
}
