// Bootstrap metadata is needed by the two music overviews, not by settings,
// plugin workspaces, search or entity pages which load their own resources.
export function musicOverviewNeedsBootstrap({ activePage, activeRoute, isViewingAdmin, isArtistDrawerOpen }) {
  return !isViewingAdmin && !isArtistDrawerOpen
    && (!activeRoute || activeRoute.type === 'page')
    && ['home', 'library'].includes(activePage);
}
