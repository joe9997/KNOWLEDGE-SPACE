import { OrbitMark } from '../OrbitMark';

export function AboutSection() {
  return (
    <div className="settings-panel glass-panel">
      <div className="settings-panel__head settings-panel__head--center">
        <OrbitMark size={46} />
        <h1>回源 · KNOWLEDGE SPACE</h1>
        <p>可溯源、可自测的知识网络。</p>
      </div>

      <div className="about-block">
        <h2>关于</h2>
        <p>
          回源把散落的材料整理成一张可交互的知识网络：从原文里抽取概念，用问答与间隔复习巩固记忆，
          并始终保留每个概念的原文出处，让知识「有据可查」。
        </p>
      </div>

      <div className="about-block">
        <h2>数据与隐私</h2>
        <p>
          你的账号、会话与复习进度保存在本地后端（data 目录），仅在你的设备上运行。
          接入的自带 API Key 只存在当前浏览器标签页，关闭即清除，不写入源码或本地数据库。
        </p>
      </div>

      <div className="about-block">
        <h2>版本</h2>
        <p>v1.0.0 · React + TypeScript + Express</p>
      </div>
    </div>
  );
}
