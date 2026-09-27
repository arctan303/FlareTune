import test from 'node:test';
import assert from 'node:assert/strict';
import { useUIStore } from './useUIStore.js';

test('page return requires approval from an unsaved lyric editor guard', () => {
  const previous = useUIStore.getState();
  try {
    useUIStore.setState({ lyricsWorkspaceExitApproved: false, lyricsWorkspaceBeforeCloseGuard: null });
    let checks = 0;
    useUIStore.getState().setLyricsWorkspaceBeforeCloseGuard(() => {
      checks += 1;
      return checks > 1;
    });
    assert.equal(useUIStore.getState().approveLyricsWorkspaceExit(), false);
    assert.equal(useUIStore.getState().lyricsWorkspaceExitApproved, false);
    assert.equal(useUIStore.getState().approveLyricsWorkspaceExit(), true);
    assert.equal(useUIStore.getState().lyricsWorkspaceExitApproved, true);
  } finally {
    useUIStore.setState({
      lyricsWorkspaceExitApproved: previous.lyricsWorkspaceExitApproved,
      lyricsWorkspaceBeforeCloseGuard: previous.lyricsWorkspaceBeforeCloseGuard,
    });
  }
});
