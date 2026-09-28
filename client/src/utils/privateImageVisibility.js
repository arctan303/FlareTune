export function visibleImageSource(requestedSrc, displaySrc, fallback, registry) {
  if (!displaySrc) return null;
  if (!registry.isPrivateMediaUrl(requestedSrc)) return displaySrc;
  if (displaySrc === fallback && !registry.isPrivateMediaUrl(fallback)) return displaySrc;
  if (!registry.shouldLoadPrivately(requestedSrc)) return null;
  return registry.getReadySource(requestedSrc) === displaySrc ? displaySrc : null;
}
