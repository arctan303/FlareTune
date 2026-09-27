import React from 'react';
import { Check } from 'lucide-react';
import { AVAILABLE_PLAYER_MODES, PLAYER_MODE_META } from '../constants/playerModes.js';

export default function PlayerModeChoices({ currentMode, onSelect }) {
  return AVAILABLE_PLAYER_MODES.map((mode) => {
    const { icon: Icon, name } = PLAYER_MODE_META[mode];
    const selected = currentMode === mode;

    return (
      <button
        key={mode}
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        data-player-mode-option={mode}
        data-active={selected}
        onClick={() => onSelect(mode)}
        className={`classic-controls__menu-item flex min-h-10 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-white ${selected ? 'bg-white/15 font-medium text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}
      >
        <Icon size={17} strokeWidth={1.8} className="classic-controls__menu-icon shrink-0" />
        <span className="flex-1">{name}</span>
        {selected && <Check size={16} aria-hidden="true" />}
      </button>
    );
  });
}
