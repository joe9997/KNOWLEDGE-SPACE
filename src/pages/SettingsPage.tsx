import { useState } from 'react';
import { Info, KeyRound, UserRound } from 'lucide-react';
import { ApiConfigPage } from './ApiConfigPage';
import { UserSettings } from '../components/settings/UserSettings';
import { AboutSection } from '../components/settings/AboutSection';

type Section = 'user' | 'api' | 'about';

export type SettingsSection = Section;

const SECTIONS: Array<{ id: Section; label: string; icon: typeof UserRound }> = [
  { id: 'user', label: '用户设置', icon: UserRound },
  { id: 'api', label: 'API 设置', icon: KeyRound },
  { id: 'about', label: '关于', icon: Info },
];

export function SettingsPage({ initialSection = 'user' }: { initialSection?: Section }) {
  const [section, setSection] = useState<Section>(initialSection);

  return (
    <div className="settings-page">
      <nav className="settings-menu" aria-label="设置">
        {SECTIONS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={section === item.id ? 'is-active' : ''}
              onClick={() => setSection(item.id)}
              aria-current={section === item.id ? 'page' : undefined}
            >
              <Icon size={16} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="settings-content">
        {section === 'user' && <UserSettings />}
        {section === 'api' && <ApiConfigPage />}
        {section === 'about' && <AboutSection />}
      </div>
    </div>
  );
}
