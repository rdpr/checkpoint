import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
export function Appearance() {
  const { mode, setMode } = useTheme();
  return (
    <div className="appearance segmented" role="group" aria-label="Appearance">
      {(
        [
          { value: 'light', label: 'Light', Icon: Sun },
          { value: 'dark', label: 'Dark', Icon: Moon },
          { value: 'system', label: 'System', Icon: Monitor },
        ] as const
      ).map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          title={label}
          aria-label={`${label} appearance`}
          aria-pressed={mode === value}
          className={mode === value ? 'active' : ''}
          onClick={() => setMode(value)}
        >
          <Icon size={15} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
