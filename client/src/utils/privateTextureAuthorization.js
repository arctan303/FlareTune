export function isTextureAuthorized(coverUrl, routeRevision, authorization, registry) {
  if (!registry.isPrivateMediaUrl(coverUrl)) return true;
  return authorization?.coverUrl === coverUrl
    && authorization.routeRevision === routeRevision
    && authorization.source === registry.getReadySource(coverUrl);
}
