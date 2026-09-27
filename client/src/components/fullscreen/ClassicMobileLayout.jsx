import React from 'react';
import { MobileSongPane } from './MobileClassicPanes.jsx';
import MobilePlayerLayout from './MobilePlayerLayout.jsx';
import ClassicArtwork from './ClassicArtwork.jsx';

export default function ClassicMobileLayout({ songPaneProps, mobileSongSurfaceVisible, ...layoutProps }) {
  return (
    <MobilePlayerLayout
      {...layoutProps}
      songPane={
        <MobileSongPane
          {...songPaneProps}
          isMobile
          artwork={<ClassicArtwork coverUrl={songPaneProps.coverUrl} isPlaying={songPaneProps.isPlaying} isBuffering={songPaneProps.isBuffering} isExpandingToSong={songPaneProps.isExpandingToSong} />}
          surfaceVisible={mobileSongSurfaceVisible}
        />
      }
    />
  );
}
