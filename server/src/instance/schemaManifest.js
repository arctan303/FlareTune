export const CURRENT_SCHEMA_VERSION = 2;
export const MIN_SUPPORTED_SCHEMA_VERSION = 1;

export const KNOWN_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: '0001_baseline.sql',
    checksum: 'b7e91ab45df5adc1389afb58b53bd87e23af85b7d45e7a06e6c931f586737481',
    stage: 'baseline',
  }),
  Object.freeze({
    version: 2,
    name: '0002_expand_playlist_count.sql',
    checksum: '43bcc176650fcf7effecd4867ccab2763cd97497a836b22dadef76282b0b9f02',
    stage: 'migrate',
  }),
]);
