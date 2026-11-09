import React from 'react';
import { getMusicSourcesRevision, subscribeMusicSources } from '../services/musicSources.js';

export function useMusicSourcesRevision() {
  const [revision, setRevision] = React.useState(getMusicSourcesRevision);
  React.useEffect(() => {
    const unsubscribe = subscribeMusicSources(setRevision);
    setRevision(getMusicSourcesRevision());
    return unsubscribe;
  }, []);
  return revision;
}
