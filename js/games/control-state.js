export function isGameSnapshot(payload) {
  return Boolean(payload)
    && Array.isArray(payload.teams)
    && Array.isArray(payload.completedQuestionIds)
    && Object.hasOwn(payload, "round");
}
