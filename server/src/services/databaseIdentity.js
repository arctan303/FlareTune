// Only host-created adapters can register a backing database. This is not an
// SDK export: structural lookalikes supplied by plugins convey no authority.
const backing = new WeakMap();
export const databaseIdentity = database => backing.get(database) || database;
export function registerDatabaseWrapper(wrapper, database) {
  backing.set(wrapper, databaseIdentity(database));
  return wrapper;
}
