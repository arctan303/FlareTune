import React from 'react';
import {
  VISUAL_MOTION_PHASE,
  VISUAL_MOTION_PROFILE,
  getVisualMotionProfile,
} from '../utils/motionPerformance';

export function useVisualMotionProfile(visualMotionPhase = VISUAL_MOTION_PHASE.IDLE) {
  const [profile, setProfile] = React.useState(() => (
    typeof window !== 'undefined' ? getVisualMotionProfile(window) : VISUAL_MOTION_PROFILE.FULL
  ));

  const pendingProfileRef = React.useRef(null);
  const timerRef = React.useRef(null);
  const visualMotionPhaseRef = React.useRef(visualMotionPhase);
  visualMotionPhaseRef.current = visualMotionPhase;

  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const commitProfile = (nextProfile) => {
      if (visualMotionPhaseRef.current === VISUAL_MOTION_PHASE.IDLE) {
        setProfile(nextProfile);
        pendingProfileRef.current = null;
      } else {
        pendingProfileRef.current = nextProfile;
      }
    };

    const handleDebouncedCheck = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const nextProfile = getVisualMotionProfile(window);
        commitProfile(nextProfile);
      }, 100);
    };

    // 绑定 resize, visualViewport resize, 及 3 档媒体查询
    window.addEventListener('resize', handleDebouncedCheck);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleDebouncedCheck);
    }

    const mediaQueries = [
      '(prefers-reduced-motion: reduce)',
      '(pointer: coarse)',
      '(pointer: fine)',
      '(hover: none)',
      '(hover: hover)',
    ];
    const mqls = mediaQueries.map((q) => window.matchMedia(q));
    mqls.forEach((mql) => mql.addEventListener('change', handleDebouncedCheck));

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      window.removeEventListener('resize', handleDebouncedCheck);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleDebouncedCheck);
      }
      mqls.forEach((mql) => mql.removeEventListener('change', handleDebouncedCheck));
    };
  }, []);

  // 当动画阶段恢复到 IDLE 且有待提交的档位时，立即提交
  React.useEffect(() => {
    if (visualMotionPhase === VISUAL_MOTION_PHASE.IDLE && pendingProfileRef.current !== null) {
      setProfile(pendingProfileRef.current);
      pendingProfileRef.current = null;
    }
  }, [visualMotionPhase]);

  return profile;
}
