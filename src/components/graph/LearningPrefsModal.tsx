import { useEffect, useState } from 'react';
import { ListChecks, Palette, Timer } from 'lucide-react';
import {
  MAX_BASE_DAYS,
  MIN_BASE_DAYS,
  PALETTE_THEMES,
  QUIZ_OPTIONS,
  RHYTHM_OPTIONS,
  paletteVariant,
} from '../../lib/learningPrefs';
import type { Mastery } from '../../lib/types';
import { useApp } from '../../state/AppStore';
import { Modal } from '../ui/Modal';

interface LearningPrefsModalProps {
  open: boolean;
  onClose: () => void;
}

const MASTERY_STEPS: Mastery[] = [0, 1, 2];

export function LearningPrefsModal({ open, onClose }: LearningPrefsModalProps) {
  const { learningPrefs, updateLearningPrefs } = useApp();
  const [light, setLight] = useState(
    () => document.documentElement.dataset.theme === 'light',
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setLight(document.documentElement.dataset.theme === 'light');
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  const factor =
    RHYTHM_OPTIONS.find((option) => option.id === learningPrefs.rhythm)?.factor ?? 1;
  const masteryDays = Math.max(1, Math.round(learningPrefs.baseDays * 1.6 * factor));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="个性化学习"
      eyebrow="PERSONAL STUDY"
      size="md"
    >
      <section className="prefs-section">
        <p className="prefs-section__title">
          <Palette size={14} />
          星球配色
        </p>
        <p className="prefs-section__hint">
          颜色仍按掌握度区分，只替换色系；没记住、有点模糊、已掌握始终对应由浅到深的三个阶段。
        </p>
        <div className="prefs-palette-grid">
          {PALETTE_THEMES.map((option) => (
            <button
              key={option.id}
              type="button"
              className="prefs-palette-card"
              aria-pressed={learningPrefs.palette === option.id}
              onClick={() => updateLearningPrefs({ palette: option.id })}
            >
              <span className="prefs-swatch" aria-hidden="true">
                {MASTERY_STEPS.map((mastery) => (
                  <i
                    key={mastery}
                    style={{ background: paletteVariant(option.id, mastery, light, 1).core }}
                  />
                ))}
              </span>
              <strong>{option.label}</strong>
              <span>{option.hint}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="prefs-section">
        <p className="prefs-section__title">
          <Timer size={14} />
          学习节奏与记忆天数
        </p>
        <p className="prefs-section__hint">
          掌握后的基础间隔为 {learningPrefs.baseDays} 天，连续答对会按 1.6 倍递增；
          按当前节奏，第一次答对后约 {masteryDays} 天再复习。
        </p>
        <div className="prefs-rhythm-grid">
          {RHYTHM_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className="prefs-option"
              aria-pressed={learningPrefs.rhythm === option.id}
              onClick={() => updateLearningPrefs({ rhythm: option.id })}
            >
              <strong>{option.label}</strong>
              <span>{option.hint}</span>
            </button>
          ))}
        </div>
        <label className="prefs-range">
          <span>
            基础记忆天数
            <em>{learningPrefs.baseDays} 天</em>
          </span>
          <input
            type="range"
            min={MIN_BASE_DAYS}
            max={MAX_BASE_DAYS}
            step={1}
            value={learningPrefs.baseDays}
            onChange={(event) =>
              updateLearningPrefs({ baseDays: Number(event.target.value) })
            }
          />
          <span className="prefs-range__scale">
            <span>{MIN_BASE_DAYS} 天</span>
            <span>{MAX_BASE_DAYS} 天</span>
          </span>
        </label>
      </section>

      <section className="prefs-section">
        <p className="prefs-section__title">
          <ListChecks size={14} />
          题库默认方式
        </p>
        <p className="prefs-section__hint">打开题库时直接进入你更习惯的学习方式。</p>
        <div className="prefs-chips">
          {QUIZ_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className="prefs-chip"
              aria-pressed={learningPrefs.quizMode === option.id}
              onClick={() => updateLearningPrefs({ quizMode: option.id })}
              title={option.hint}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <p className="prefs-footnote">
        偏好按账号保存在本机，修改会立即应用到之后的评级与复习安排。
      </p>
    </Modal>
  );
}
