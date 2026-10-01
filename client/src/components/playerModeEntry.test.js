import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { AVAILABLE_PLAYER_MODES, PLAYER_MODE_META, PLAYER_MODES } from '../constants/playerModes.js';

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('only classic and artist-photo presentations are available', () => {
  assert.deepEqual(AVAILABLE_PLAYER_MODES, [PLAYER_MODES.CLASSIC, PLAYER_MODES.CINEMATIC]);
  assert.equal(PLAYER_MODE_META[PLAYER_MODES.CLASSIC].name, '经典播放器');
  assert.equal(PLAYER_MODE_META[PLAYER_MODES.CINEMATIC].name, '歌手写真');
});

test('desktop icon reveals its current mode on hover while mobile uses its existing more menus', () => {
  const entry = readSource('./PlayerSkinEntry.jsx');
  const choices = readSource('./PlayerModeChoices.jsx');
  const classic = readSource('./fullscreen/ClassicDesktopLayout.jsx');
  const mobile = readSource('./fullscreen/MobilePlayerLayout.jsx');
  const panes = readSource('./fullscreen/MobileClassicPanes.jsx');
  const immersive = readSource('./fullscreen/DesktopImmersivePlayer.jsx');
  const menu = readSource('./PlayerMoreMenu.jsx');
  const app = readSource('../app.jsx');

  assert.match(entry, /const Icon = playerMode === PLAYER_MODES\.CLASSIC \? Disc3 : UserRound/);
  assert.match(entry, /data-player-mode=\{playerMode\}/);
  assert.match(entry, /aria-label=\{t\("当前\{p0\}，点击切换到\{p1\}"/);
  assert.match(entry, /onClick=\{\(\) => setPlayerMode\(nextMode\)\}/);
  assert.match(entry, /group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100/);
  assert.match(entry, /t\("当前："\)\}\{currentLabel\}/);
  assert.doesNotMatch(entry, /aria-haspopup|<PlayerModeChoices/);
  assert.match(choices, /AVAILABLE_PLAYER_MODES\.map/);
  assert.match(choices, /aria-checked=\{selected\}/);
  assert.match(classic, /<PlayerSkinEntry variant="classic" \/>/);
  assert.doesNotMatch(mobile, /PlayerSkinEntry/);
  assert.match(panes, /<PlayerMoreMenu[\s\S]*?showPlayerModes \/>/);
  assert.match(panes, /showPlayerModes=\{isMobile\}/);
  assert.match(immersive, /modeSwitcher=\{<PlayerSkinEntry variant="immersive" \/>\}/);
  assert.match(menu, /showPlayerModes && \([\s\S]*?<PlayerModeChoices/);
  assert.doesNotMatch(menu, /nextPlayerMode|切换到：/);
  assert.doesNotMatch(app, /PlayerSkinDrawer/);
  assert.equal(existsSync(new URL('./PlayerSkinDrawer.jsx', import.meta.url)), false);
});

test('desktop artist player uses current cover only as a photo fallback', () => {
  const immersive = readSource('./fullscreen/DesktopImmersivePlayer.jsx');
  const background = readSource('./fullscreen/ImmersiveBackground.jsx');
  assert.match(immersive, /resolveCoverUrl\(currentSong\?\.cover_url \|\| ''\)/);
  assert.match(background, /resolvedCoverUrl = usePrivateMediaSource\(coverUrl\)/);
  assert.match(background, /!showPhotos && resolvedCoverUrl && <img src=\{resolvedCoverUrl\}/);
  assert.doesNotMatch(background, /<video|videoSrc|natural-scenery/);
});
