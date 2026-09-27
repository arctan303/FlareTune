console.error([
  'FlareTune production deployment is intentionally disabled in Phase 01.',
  'The empty-database baseline and deployment migrations are implemented in Phase 02.',
  'No Worker, D1 database, or R2 bucket was changed.',
].join('\n'));
process.exitCode = 1;
