import React from 'react';
import { MobileSongPane } from './MobileClassicPanes.jsx';
import MobilePlayerLayout from './MobilePlayerLayout.jsx';
import ArtistArtwork from './ArtistArtwork.jsx';

export default function ArtistMobileLayout({ songPaneProps, mobileSongSurfaceVisible, showMobilePhotos, ...layoutProps }) {
  return (
    <MobilePlayerLayout
      {...layoutProps}
      songPane={
        <MobileSongPane
          {...songPaneProps}
          isMobile
          artwork={<ArtistArtwork showPhotos={showMobilePhotos} canShowLyrics={songPaneProps.canShowLyrics} coverUrl={songPaneProps.coverUrl} isPlaying={songPaneProps.isPlaying} isBuffering={songPaneProps.isBuffering} isExpandingToSong={songPaneProps.isExpandingToSong} />}
          surfaceVisible={mobileSongSurfaceVisible}
        />
      }
    />
  );
}
