import React from 'react';
import { PageActivityContext } from '../hooks/usePageActivity.js';

// Mount on the first visit, then keep the bounded page subtree while hidden.
// The caller keys this boundary by session so identity changes discard it.
export default function RetainedPage({ active, children }) {
  const [visited, setVisited] = React.useState(active);
  const [restored, setRestored] = React.useState(false);
  if (active && !visited) setVisited(true);
  if (!active && visited && !restored) setRestored(true);
  if (!active && !visited) return null;
  return <div className="retained-page" data-restored={restored}
    hidden={!active} style={active ? undefined : { display: 'none' }}>
    <PageActivityContext.Provider value={active}>{children}</PageActivityContext.Provider>
  </div>;
}
