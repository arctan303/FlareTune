export function localAssistantMutationHeaders(csrfToken) {
  if (typeof csrfToken !== 'string' || !csrfToken) {
    throw new Error('登录会话已失效，请重新登录。');
  }
  return {
    'Content-Type': 'application/json',
    'X-Requested-With': 'FlareTune',
    'X-CSRF-Token': csrfToken,
  };
}
