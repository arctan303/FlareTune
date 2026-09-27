import React from 'react';
import { useMediaQuery } from '../fullscreen/useMediaQuery.js';

export default function ScrollingText({ children, className = '', align = 'center' }) {
    const containerRef = React.useRef(null);
    const textRef = React.useRef(null);
    const [scrollDist, setScrollDist] = React.useState(0);
    const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)', false);
    const isLeft = align === 'left' || className.includes('text-left');

    React.useEffect(() => {
        const checkOverflow = () => {
            if (!containerRef.current || !textRef.current) return;
            const diff = textRef.current.scrollWidth - containerRef.current.clientWidth;
            setScrollDist(diff > 0 ? diff : 0);
        };
        checkOverflow();
        window.addEventListener('resize', checkOverflow);
        return () => window.removeEventListener('resize', checkOverflow);
    }, [children]);

    const maskStyle = scrollDist > 0
        ? (isLeft
            ? 'linear-gradient(to right, black 0%, black calc(100% - 14px), transparent 100%)'
            : 'linear-gradient(to right, transparent 0%, black 10px, black calc(100% - 14px), transparent 100%)')
        : 'none';

    return (
        <div
            ref={containerRef}
            className={`overflow-hidden whitespace-nowrap ${isLeft ? 'text-left' : 'text-center'} ${className}`}
            style={{
                maskImage: maskStyle,
                WebkitMaskImage: maskStyle,
            }}
        >
            <div
                ref={textRef}
                className={`inline-flex items-center gap-1 ${scrollDist > 0 ? '' : (isLeft ? 'justify-start w-full' : 'justify-center w-full')}`}
                style={{
                    animation: scrollDist > 0 && !prefersReducedMotion ? 'text-scroll 6s ease-in-out infinite alternate' : 'none',
                    '--scroll-dist': `-${scrollDist + 15}px`,
                }}
            >
                {children}
            </div>
        </div>
    );
}
