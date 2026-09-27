import React from 'react';
import DesktopImmersivePlayer from './fullscreen/DesktopImmersivePlayer';
import MobileClassicPlayer from './fullscreen/MobileClassicPlayer';
import MobileArtistPlayer from './fullscreen/MobileArtistPlayer';
import { useUIStore } from '../store/useUIStore';
import { PLAYER_MODES } from '../constants/playerModes';
import { useMediaQuery } from './fullscreen/useMediaQuery';

export default function FullScreenPlayer({ motionProfile = 'full' }) {
  const playerMode = useUIStore((state) => state.playerMode);
  const isDesktop = useMediaQuery('(min-width: 1024px)', false);

  // 形态切换时新组件跳过全屏滑入动画，改用淡入；首次打开全屏保持滑入
  const prevModeRef = React.useRef(playerMode);
  const instantEnter = prevModeRef.current !== playerMode;
  if (instantEnter) prevModeRef.current = playerMode;

  // 写真形态在桌面使用舞台，在窄屏使用独立的写真画面。
  if (playerMode === PLAYER_MODES.CINEMATIC && isDesktop) {
    return <DesktopImmersivePlayer motionProfile={motionProfile} instantEnter={instantEnter} />;
  }
  if (playerMode === PLAYER_MODES.CINEMATIC) {
    return <MobileArtistPlayer instantEnter={instantEnter} />;
  }

  // 经典形态：桌面和窄屏共用播放状态，布局分别维护。
  return <MobileClassicPlayer instantEnter={instantEnter} />;
}
