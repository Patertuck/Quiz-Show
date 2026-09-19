export async function sendHostCommand({ instanceName, expectedRevision, command }) {
  const response = await fetch("/api/host/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instanceName, expectedRevision, command })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

