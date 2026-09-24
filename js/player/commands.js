export async function sendPlayerCommand(type, payload, fetchApi = fetch) {
  const response = await fetchApi("/api/player/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, payload })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `HTTP ${response.status}`);
    error.payload = result;
    error.status = response.status;
    throw error;
  }
  return result;
}

export const playerCommands = {
  teamLobby: (payload) => sendPlayerCommand("team-lobby", payload),
  buzz: (payload) => sendPlayerCommand("buzz", payload),
  ordering: (payload) => sendPlayerCommand("ordering", payload),
  listing: (payload) => sendPlayerCommand("listing", payload),
  syncTeam: (payload) => sendPlayerCommand("sync-team", payload),
  syncRegister: (payload) => sendPlayerCommand("sync-register", payload),
  syncReconnect: (payload) => sendPlayerCommand("sync-reconnect", payload),
  syncVote: (payload) => sendPlayerCommand("sync-vote", payload)
};
