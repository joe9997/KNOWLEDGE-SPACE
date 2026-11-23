import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../../theme/ThemeProvider';

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const next = theme === 'dark' ? '浅色' : '深色';
  return (
    <button
      type="button"
      className={`icon-button theme-toggle ${className}`.trim()}
      onClick={toggleTheme}
      aria-label={`切换为${next}主题`}
      title={`切换为${next}主题`}
    >
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
