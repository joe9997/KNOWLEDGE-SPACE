import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Fingerprint, Loader2, Save, Trash2, Upload } from 'lucide-react';
import { useApp } from '../../state/AppStore';
import { passkeySupported, registerPasskey, removePasskey, STATIC_DEPLOY } from '../../lib/auth';

function compressAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const size = 192;
        const scale = Math.min(1, size / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(String(reader.result ?? ''));
          return;
        }
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      image.onerror = () => reject(new Error('无法解析图片'));
      image.src = String(reader.result ?? '');
    };
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

export function UserSettings() {
  const { currentUser, updateProfile, changePassword, refreshUser } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState(currentUser?.username ?? '');
  const [email, setEmail] = useState(currentUser?.email ?? '');
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  if (!currentUser) {
    return null;
  }

  const run = async (action: () => Promise<void>, okText: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      await action();
      setFeedback({ kind: 'ok', text: okText });
    } catch (cause) {
      setFeedback({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = (event: FormEvent) => {
    event.preventDefault();
    void run(
      () => updateProfile({ username: username.trim(), email: email.trim() }),
      '资料已更新',
    );
  };

  const savePassword = (event: FormEvent) => {
    event.preventDefault();
    if (newPwd !== confirmPwd) {
      setFeedback({ kind: 'error', text: '两次输入的新密码不一致' });
      return;
    }
    void run(() => changePassword(currentPwd, newPwd), '密码已更新').then(() => {
      setCurrentPwd('');
      setNewPwd('');
      setConfirmPwd('');
    });
  };

  const onAvatarChange = async (file: File | null) => {
    if (!file) {
      return;
    }
    try {
      const avatar = await compressAvatar(file);
      await run(() => updateProfile({ avatar }), '头像已更新');
    } catch (cause) {
      setFeedback({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const onPasskeyRegister = async () => {
    setPasskeyBusy(true);
    setFeedback(null);
    try {
      await registerPasskey();
      setFeedback({ kind: 'ok', text: 'Passkey 已注册' });
      await refreshUser();
    } catch (cause) {
      setFeedback({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setPasskeyBusy(false);
    }
  };

  const onPasskeyRemove = async () => {
    setPasskeyBusy(true);
    setFeedback(null);
    try {
      await removePasskey();
      setFeedback({ kind: 'ok', text: 'Passkey 已移除' });
      await refreshUser();
    } catch (cause) {
      setFeedback({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setPasskeyBusy(false);
    }
  };

  return (
    <div className="settings-panel glass-panel">
      <div className="settings-panel__head">
        <p className="eyebrow">ACCOUNT</p>
        <h1>用户设置</h1>
        <p>管理你的头像、登录信息与安全凭证。</p>
      </div>

      {feedback && <div className={`form-message is-${feedback.kind === 'ok' ? 'success' : 'error'}`}>{feedback.text}</div>}

      <section className="settings-section">
        <h2>头像</h2>
        <div className="avatar-row">
          <span className="avatar avatar--lg" aria-hidden="true">
            {currentUser.avatar ? <img src={currentUser.avatar} alt="头像" /> : currentUser.username.slice(0, 1).toUpperCase()}
          </span>
          <div className="avatar-actions">
            <button type="button" className="glass-button glass-button--quiet" onClick={() => fileRef.current?.click()}>
              <Upload size={14} />
              上传头像
            </button>
            {currentUser.avatar && (
              <button
                type="button"
                className="glass-button glass-button--quiet"
                onClick={() => void run(() => updateProfile({ avatar: null }), '头像已移除')}
              >
                <Trash2 size={14} />
                移除
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="assistant-chat__file-input"
              onChange={(event) => {
                void onAvatarChange(event.target.files?.[0] ?? null);
                event.target.value = '';
              }}
            />
          </div>
        </div>
      </section>

      <form className="settings-section" onSubmit={saveProfile}>
        <h2>账号资料</h2>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="su-username">用户名</label>
            <input id="su-username" value={username} onChange={(event) => setUsername(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="su-email">邮箱</label>
            <input id="su-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
        </div>
        <div className="form-actions">
          <button type="submit" className="glass-button" disabled={busy}>
            <Save size={14} />
            保存资料
          </button>
        </div>
      </form>

      <form className="settings-section" onSubmit={savePassword}>
        <h2>修改密码</h2>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="su-current">当前密码</label>
            <input
              id="su-current"
              type="password"
              value={currentPwd}
              onChange={(event) => setCurrentPwd(event.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="field">
            <label htmlFor="su-new">新密码</label>
            <input
              id="su-new"
              type="password"
              value={newPwd}
              onChange={(event) => setNewPwd(event.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div className="field">
            <label htmlFor="su-confirm">确认新密码</label>
            <input
              id="su-confirm"
              type="password"
              value={confirmPwd}
              onChange={(event) => setConfirmPwd(event.target.value)}
              autoComplete="new-password"
            />
          </div>
        </div>
        <div className="form-actions">
          <button type="submit" className="glass-button" disabled={busy}>
            <Save size={14} />
            更新密码
          </button>
        </div>
      </form>

      <section className="settings-section">
        <h2>Passkey</h2>
        <p className="settings-hint">
          {currentUser.hasPasskey ? '已设置 Passkey，可用来免密登录。' : '尚未设置 Passkey。注册后可使用设备生物识别或安全密钥登录。'}
        </p>
        {passkeySupported() ? (
          <div className="form-actions">
            {currentUser.hasPasskey ? (
              <button type="button" className="glass-button glass-button--quiet" onClick={onPasskeyRemove} disabled={passkeyBusy}>
                {passkeyBusy ? <Loader2 size={14} className="spinner" /> : <Trash2 size={14} />}
                移除 Passkey
              </button>
            ) : (
              <button type="button" className="glass-button" onClick={onPasskeyRegister} disabled={passkeyBusy}>
                {passkeyBusy ? <Loader2 size={14} className="spinner" /> : <Fingerprint size={14} />}
                注册 Passkey
              </button>
            )}
          </div>
        ) : (
          <p className="settings-hint">
            {STATIC_DEPLOY ? '静态体验版不支持 Passkey。' : '当前浏览器不支持 WebAuthn / Passkey。'}
          </p>
        )}
      </section>
    </div>
  );
}
