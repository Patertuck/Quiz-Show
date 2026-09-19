export function ownSyncParticipant(state) {
  return state?.participants.find((item) => item.id === state.selfParticipantId) || null;
}
