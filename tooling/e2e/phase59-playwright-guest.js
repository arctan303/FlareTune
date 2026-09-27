async (page) => {
  const xiaoaRequests = [];

  await page.context().unroute('**/api/ai/auth/session').catch(() => {});
  await page.context().unroute('**/api/ai/bootstrap').catch(() => {});
  await page.context().unroute('**/api/ai/thread').catch(() => {});
  await page.context().unroute('**/api/ai/chat').catch(() => {});
  await page.context().route('**/api/ai/auth/session', async (route) => {
    await route.fulfill({
      status: 200,
      json: { authenticated: false, ssoConfigured: true },
    });
  });

  page.on('request', (request) => {
    if (/\/api\/ai\/(bootstrap|thread|chat)(?:\?|$)/.test(request.url())) {
      xiaoaRequests.push(request.url());
    }
  });

  await page.goto('http://127.0.0.1:3001/');
  await page.getByRole('button', { name: '打开小A助手' }).click();
  await page.waitForTimeout(250);

  return page.evaluate((capturedRequests) => {
    const dialog = document.querySelector('[role="dialog"]');
    const loginText = Array.from(dialog?.querySelectorAll('*') ?? [])
      .find((element) => element.children.length === 0 && element.textContent?.trim() === '需要登录');
    const content = loginText?.parentElement ?? loginText;

    return {
      dialogText: dialog?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      loginText: loginText?.textContent?.trim() ?? null,
      contentInteractiveCount: content?.querySelectorAll(
        'button, input, textarea, select, a[href], [role="button"]',
      ).length ?? null,
      xiaoaRequestCount: capturedRequests.length,
      xiaoaRequests: capturedRequests,
    };
  }, xiaoaRequests);
}
