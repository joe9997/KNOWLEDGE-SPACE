import { CalendarClock } from 'lucide-react';
import { useApp } from '../state/AppStore';

const OPTIONS = [
  { days: 0, label: '今天' },
  { days: 3, label: '三天后' },
  { days: 7, label: '七天后' },
];

export function TimeTravel({ compact = false }: { compact?: boolean }) {
  const { offsetDays, setOffsetDays } = useApp();
  return (
    <div className={`time-travel ${compact ? 'time-travel--compact' : ''}`.trim()}>
      <span className="time-travel__label">
        <CalendarClock size={14} aria-hidden="true" />
        演示时间
      </span>
      <div className="time-travel__options" role="group" aria-label="演示时间切换">
        {OPTIONS.map((option) => (
          <button
            key={option.days}
            type="button"
            className={`time-travel__option ${offsetDays === option.days ? 'is-active' : ''}`}
            aria-pressed={offsetDays === option.days}
            onClick={() => setOffsetDays(option.days)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
