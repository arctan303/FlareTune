export function visibleImageSource(requestedSrc, displaySrc, fallback, registry, retainDisplayed = false) {
  if (!displaySrc) return null;
  if (!registry.isPrivateMediaUrl(requestedSrc)) return displaySrc;
  if (displaySrc === fallback && !registry.isPrivateMediaUrl(fallback)) return displaySrc;
  if (!registry.shouldLoadPrivately(requestedSrc)) return null;
  if (retainDisplayed && registry.canRetainSource(requestedSrc, displaySrc)) return displaySrc;
  return registry.getReadySource(requestedSrc) === displaySrc ? displaySrc : null;
}
