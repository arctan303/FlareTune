import { usePlayerStore } from '../store/usePlayerStore.js';
import { showToast } from '../store/useUIStore.js';
import { hydratePlayableSong } from '../utils.js';
import {
    applyPlaySongNow, applyPlayerControl, applyPlayerQueueEdit,
    applyReplacePlayerQueue, applyRoamControl,
} from '../assistantPlayerActions.js';
import { dispatchAiPlayerAction } from './aiPlayerActionDispatch.js';

const getState = usePlayerStore.getState;

export function dispatchLocalAssistantPlayerAction(action) {
    return dispatchAiPlayerAction(action, {
        hydrateSong: hydratePlayableSong,
        playNow: (song) => applyPlaySongNow(song, { getState }),
        insertNext: (song) => applyPlayerQueueEdit({ operation: 'insert_next', songs: [song] }, { getState }),
        replaceQueue: (songs) => applyReplacePlayerQueue(songs, { getState }),
        appendQueue: (songs) => applyPlayerQueueEdit({ operation: 'append', songs }, { getState }),
        controlPlayer: (args) => applyPlayerControl(args, { getState }),
        setRoam: (args) => applyRoamControl(args, { getState }),
        notify: showToast,
    });
}
