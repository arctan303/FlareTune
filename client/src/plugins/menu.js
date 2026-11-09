// Copy the action context at invocation, so a clicked list song can never be
// silently replaced by the currently playing song while a dialog is opening.
export function createPluginMenuContext(slot, { song, player = {}, output } = {}) {
  return Object.freeze({ slot,
    song: slot === 'menu.song' && song ? Object.freeze({ ...song }) : null,
    playback: slot === 'menu.player' ? Object.freeze({
      currentSong: player.currentSong ? Object.freeze({ ...player.currentSong }) : null,
      queue: Object.freeze((player.playlist || []).map(item => Object.freeze({ ...item }))),
      isPlaying: Boolean(player.isPlaying), currentTime: player.currentTime,
      output: output ? Object.freeze({ pluginId: output.pluginId, id: output.id, name: output.name }) : null,
    }) : null,
  });
}
