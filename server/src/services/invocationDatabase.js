const budgets = new WeakMap();
const rawStatement = Symbol('invocationStatement');

// One request, including waitUntil tasks. D1 batches count as one binding call;
// authorization predicates inside the transaction remain unchanged.
export function createInvocationDatabase(database, signal, {
  limit = 50, settlementReserve = 5, settlementRoom = 12,
  exhaustedCode = 'INVOCATION_BUDGET_EXHAUSTED',
} = {}) {
  let spent = 0, executingAi = false, depleted = false, settling = false;
  const controller = new AbortController();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const fail = () => { depleted = true; throw Object.assign(new Error(exhaustedCode), { code: exhaustedCode }); };
  const spend = () => { if (spent >= (executingAi ? limit - settlementReserve : limit)) fail(); spent++; };
  const budget = Object.freeze({
    signal: controller.signal,
    get depleted() { return depleted; },
    settle() { settling = true; executingAi = false; controller.abort(); },
    requireSettlementRoom() { if (limit - spent < settlementRoom) fail(); },
    async executeAi(execute) {
      if (settling || spent + 2 > limit - settlementReserve) fail();
      executingAi = true;
      try { return await execute(); } finally { executingAi = false; }
    },
  });
  const db = Object.freeze({
    prepare(sql) {
      let statement = database.prepare(sql);
      const wrapped = { get [rawStatement]() { return statement; },
        bind(...values) { statement = statement.bind(...values); return wrapped; } };
      for (const method of ['first', 'all', 'run']) wrapped[method] = (...args) => { spend(); return statement[method](...args); };
      return wrapped;
    },
    batch(statements) { spend(); return database.batch(statements.map(statement => statement[rawStatement] || statement)); },
  });
  budgets.set(db, budget);
  return db;
}

export const invocationBudget = database => budgets.get(database) || null;
