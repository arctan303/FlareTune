export function createIngestSessionGuard(owner, getSession) {
  const controller = new AbortController();
  const assertCurrent = () => {
    const current = getSession();
    if (controller.signal.aborted || !owner?.authenticated || !owner.user?.accountId
      || !current?.authenticated || current.user?.role !== 'admin'
      || current.user?.accountId !== owner.user.accountId || current.csrfToken !== owner.csrfToken) {
      controller.abort();
      throw new DOMException('入库会话已结束。', 'AbortError');
    }
  };
  return {
    signal: controller.signal,
    assertCurrent,
    close: () => controller.abort(),
    async run(operation) {
      assertCurrent();
      const result = await operation(controller.signal);
      assertCurrent();
      return result;
    },
  };
}
