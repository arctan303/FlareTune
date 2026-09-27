import { usePlayerStore } from '../store/usePlayerStore.js';
import { showToast } from '../store/useUIStore.js';
import { createInsertNextWithFeedback } from './playerActionsCore.js';

export { createInsertNextWithFeedback } from './playerActionsCore.js';

export const insertNextWithFeedback = createInsertNextWithFeedback({
  getPlayerState: usePlayerStore.getState,
  notify: showToast,
  emitBounce: () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('arc-insert-next-bounced'));
    }
  },
});
