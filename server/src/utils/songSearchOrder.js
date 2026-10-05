// Songs.title is NOT NULL in every supported schema. Rank the nullable artist
// separately so NULL still precedes empty text in indexed keyset ranges.
export const songSearchKeys = (alias = 's') => [
  `LOWER(${alias}.title)`,
  `CASE WHEN ${alias}.artist IS NULL THEN 0 ELSE 1 END`, `LOWER(COALESCE(${alias}.artist, ''))`, `${alias}.id`,
];
export const songSearchOrder = (alias = 's') => songSearchKeys(alias).join(', ');
