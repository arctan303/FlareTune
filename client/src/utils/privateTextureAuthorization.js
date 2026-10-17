export function isTextureAuthorized(coverUrl, routeRevision, authorization, registry) {
  if (!registry.isPrivateMediaUrl(coverUrl)) return true;
  return authorization?.coverUrl === coverUrl
    && authorization.routeRevision === routeRevision
    && Boolean(authorization.source)
    && (registry.canRetainSource?.(coverUrl, authorization.source, authorization.displayAuthorization)
      || authorization.source === registry.getReadySource(coverUrl));
}
