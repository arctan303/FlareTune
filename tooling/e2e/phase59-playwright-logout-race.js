async (page) => {
  let authenticated = true;
  let chatFailed = false;

  await page.context().unroute('**/api/ai/auth/session').catch(() => {});
  await page.context().unroute('**/api/ai/bootstrap').catch(() => {});
  await page.context().unroute('**/api/ai/thread').catch(() => {});
  await page.context().unroute('**/api/ai/chat').catch(() => {});

  await page.context().route('**/api/ai/auth/session', async (route) => {
    await route.fulfill({
      status: 200,
      json: authenticated
        ? {
            authenticated: true,
            ssoConfigured: true,
            user: {
              subject: 'member-browser',
              email: 'member@example.test',
              name: '成员',
              role: 'member',
            },
          }
        : { authenticated: false, ssoConfigured: true },
    });
  });

  await page.context().route('**/api/ai/bootstrap', async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        assistant: {
          welcome: '你好，我是小A。',
          quickPrompts: [],
        },
      },
    });
  });

  await page.context().route('**/api/ai/thread', async (route) => {
    if (!authenticated) {
      await route.fulfill({
        status: 401,
        json: { error: 'authentication_required', message: '请先登录后使用小A。' },
      });
      return;
    }

    await route.fulfill({
      status: 200,
      json: { thread: { revision: 0, messages: [] } },
    });
  });

  await page.context().route('**/api/ai/chat', async (route) => {
    await page.waitForTimeout(1500);
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        'data: {"type":"content","content":"LATE_CONTENT"}',
        '',
        'data: {"type":"done"}',
        '',
      ].join('\n'),
    }).catch(() => {});
  });

  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/ai/chat')) chatFailed = true;
  });

  await page.reload();
  await page.getByRole('button', { name: '打开小A助手' }).click();
  await page.getByRole('textbox', { name: '问小A关于音乐' }).fill('测试退出登录竞态');

  const chatRequest = page.waitForRequest((request) => request.url().includes('/api/ai/chat'));
  await page.getByRole('button', { name: '发送问题' }).click();
  await chatRequest;

  authenticated = false;
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('arc-auth-changed'));
  });
  await page.waitForTimeout(2000);

  return page.evaluate((wasChatFailed) => {
    const dialog = document.querySelector('[role="dialog"]');
    const exactLoginText = Array.from(dialog?.querySelectorAll('*') ?? [])
      .find((element) => element.children.length === 0 && element.textContent?.trim() === '需要登录');
    const content = exactLoginText?.parentElement ?? exactLoginText;
    const interactiveSelector = 'button, input, textarea, select, a[href], [role="button"]';

    return {
      chatRequestFailed: wasChatFailed,
      dialogText: dialog?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      loginText: exactLoginText?.textContent?.trim() ?? null,
      contentInteractiveCount: content?.querySelectorAll(interactiveSelector).length ?? null,
      lateContentPresent: dialog?.textContent?.includes('LATE_CONTENT') ?? null,
      textareaCount: dialog?.querySelectorAll('textarea').length ?? null,
    };
  }, chatFailed);
}
