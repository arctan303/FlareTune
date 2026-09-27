import React from 'react';

export function useImageInView({ rootMargin, initiallyInView = false }) {
  const containerRef = React.useRef(null);
  const [inView, setInView] = React.useState(initiallyInView);

  React.useEffect(() => {
    if (inView) return undefined;
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return undefined;
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setInView(true);
      observer.disconnect();
    }, { rootMargin });

    observer.observe(element);
    return () => observer.disconnect();
  }, [inView, rootMargin]);

  return { containerRef, inView, setInView };
}
