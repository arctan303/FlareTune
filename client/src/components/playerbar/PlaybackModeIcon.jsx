import { Repeat, Repeat1, Shuffle } from 'lucide-react';

function SequenceArrowsIcon({ size, strokeWidth }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7h17m-4-4 4 4-4 4" />
      <path d="M3 17h17m-4-4 4 4-4 4" />
    </svg>
  );
}

const MODE_ICONS = {
  sequence: SequenceArrowsIcon,
  loop: Repeat,
  single: Repeat1,
  random: Shuffle,
};

export default function PlaybackModeIcon({ mode, size = 20, strokeWidth = 2 }) {
  const Icon = MODE_ICONS[mode] || MODE_ICONS.loop;
  return <Icon size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
}
