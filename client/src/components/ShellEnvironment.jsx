import React from 'react';
import { useWallpaperStore } from '../store/useWallpaperStore';
import { showToast } from '../store/useUIStore';

export default function ShellEnvironment() {
  const enabled = useWallpaperStore((s) => s.enabled);
  const activeUrl = useWallpaperStore((s) => s.getActiveUrl());
  const imageStatus = useWallpaperStore((s) => s.imageStatus);
  const setImageStatus = useWallpaperStore((s) => s.setImageStatus);
  const blur = useWallpaperStore((s) => s.blur);
  const opacity = useWallpaperStore((s) => s.opacity);
  const brightness = useWallpaperStore((s) => s.brightness);

  React.useEffect(() => {
    void useWallpaperStore.getState().initLocalImage();
  }, []);

  React.useEffect(() => {
    setImageStatus(enabled && activeUrl ? 'loading' : 'idle');
  }, [activeUrl, enabled, setImageStatus]);

  React.useEffect(() => {
    const handleVisibility = () => {
      document.documentElement.dataset.pageHidden = document.hidden ? 'true' : 'false';
    };
    handleVisibility();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      delete document.documentElement.dataset.pageHidden;
    };
  }, []);

  const hasWallpaper = Boolean(enabled && activeUrl && imageStatus !== 'error');

  return (
    <div
      className="shell-environment shell-environment--fluid"
      aria-hidden="true"
    >
      {hasWallpaper && (
        <div
          className="shell-wallpaper"
          style={{
            '--wallpaper-blur': `${blur}px`,
            '--wallpaper-opacity': `${opacity / 100}`,
            '--wallpaper-brightness': `${brightness / 100}`,
          }}
        >
          <img
            src={activeUrl}
            alt=""
            className="shell-wallpaper__image"
            loading="eager"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={() => setImageStatus('ready')}
            onError={() => {
              setImageStatus('error');
              showToast('背景图片加载失败，已恢复默认背景');
            }}
          />
          <div className="shell-wallpaper__overlay" />
        </div>
      )}
    </div>
  );
}
