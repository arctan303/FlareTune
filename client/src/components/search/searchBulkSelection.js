export const MAX_SEARCH_BULK_SELECTION = 100;

export const toggleSearchBulkSelection = (selectedIds, songId) => {
  const normalizedId = String(songId);
  if (selectedIds.includes(normalizedId)) {
    return {
      selectedIds: selectedIds.filter((id) => id !== normalizedId),
      limitReached: false,
    };
  }
  if (selectedIds.length >= MAX_SEARCH_BULK_SELECTION) {
    return { selectedIds, limitReached: true };
  }
  return { selectedIds: [...selectedIds, normalizedId], limitReached: false };
};

export const resolveSelectedSearchSongs = (songs, selectedIds) => {
  const songsById = new Map(songs.map((song) => [String(song.id), song]));
  return selectedIds.map((id) => songsById.get(String(id))).filter(Boolean);
};
