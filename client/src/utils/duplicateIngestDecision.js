export function rejectDuplicateDecisionAfterCheckFailure(entry, error) {
  return {
    ...entry,
    duplicateState: 'error', status: 'error', allowDuplicate: false,
    replaceTarget: null, reviewStale: false,
    message: '查重失败：{reason}。此首尚未上传，可重试或明确忽略并新增。',
    messageValues: { reason: error.message },
  };
}
