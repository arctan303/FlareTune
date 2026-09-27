import React from 'react';
import MobileClassicPlayer from './MobileClassicPlayer.jsx';

export default function MobileArtistPlayer({ instantEnter = false }) {
  return <MobileClassicPlayer instantEnter={instantEnter} mobileVisual="artist" />;
}
