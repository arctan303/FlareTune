import React from 'react';

/**
 * 现代化实心圆角上一首图标
 * 内部包含独立的 .skip-bar（竖线挡板）与 .skip-arrow（三角形箭头），支持冲撞挤压动效
 */
export const SolidRoundedSkipBack = ({ size = 22, className = '', isAnimating = false, animKey = 0 }) => (
    <svg key={animKey} width={size} height={size} viewBox="0 0 24 24" fill="none" className={`skip-icon skip-icon--prev ${isAnimating ? 'is-animating' : ''} ${className}`}>
        <rect x="4.5" y="4.5" width="2.5" height="15" rx="1.25" fill="currentColor" className="skip-bar" />
        <path 
            d="M18.5 6.4c0-1.15-1.28-1.85-2.25-1.22L8.2 10.78a1.44 1.44 0 0 0 0 2.44l8.05 5.6c.97.63 2.25-.07 2.25-1.22V6.4z" 
            fill="currentColor" 
            className="skip-arrow"
        />
    </svg>
);

/**
 * 现代化实心圆角下一首图标
 * 内部包含独立的 .skip-arrow（三角形箭头）与 .skip-bar（竖线挡板），支持冲撞挤压动效
 */
export const SolidRoundedSkipForward = ({ size = 22, className = '', isAnimating = false, animKey = 0 }) => (
    <svg key={animKey} width={size} height={size} viewBox="0 0 24 24" fill="none" className={`skip-icon skip-icon--next ${isAnimating ? 'is-animating' : ''} ${className}`}>
        <path 
            d="M5.5 6.4c0-1.15 1.28-1.85 2.25-1.22l8.05 5.6a1.44 1.44 0 0 1 0 2.44l-8.05 5.6c-.97.63-2.25-.07-2.25-1.22V6.4z" 
            fill="currentColor" 
            className="skip-arrow"
        />
        <rect x="17" y="4.5" width="2.5" height="15" rx="1.25" fill="currentColor" className="skip-bar" />
    </svg>
);
