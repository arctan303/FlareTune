export function visibleImageSource(requestedSrc, displaySrc, fallback, registry, retainDisplayed = false, displayAuthorization) {
  if (!displaySrc) return null;
  if (!registry.isPrivateMediaUrl(requestedSrc)) return displaySrc;
  if (displaySrc === fallback && !registry.isPrivateMediaUrl(fallback)) return displaySrc;
  if (!registry.shouldLoadPrivately(requestedSrc)) return null;
  if (retainDisplayed && registry.canRetainSource(requestedSrc, displaySrc, displayAuthorization)) return displaySrc;
  return registry.getReadySource(requestedSrc) === displaySrc ? displaySrc : null;
}
