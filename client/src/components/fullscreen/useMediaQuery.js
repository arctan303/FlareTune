import React from 'react';

export function useMediaQuery(query, defaultValue = false) {
    const getSnapshot = React.useCallback(() => {
        if (typeof window === 'undefined') return defaultValue;
        return window.matchMedia(query).matches;
    }, [defaultValue, query]);

    const [matches, setMatches] = React.useState(getSnapshot);

    React.useEffect(() => {
        const mediaQuery = window.matchMedia(query);
        const handleChange = (event) => setMatches(event.matches);

        setMatches(mediaQuery.matches);
        mediaQuery.addEventListener('change', handleChange);

        return () => mediaQuery.removeEventListener('change', handleChange);
    }, [query]);

    return matches;
}
