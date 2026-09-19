export function createLiveConnection({ role, identity = () => ({}), onSnapshot, onConnectionChange = () => {} }) {
  let socket = null;
  let stopped = false;
  let retryTimer = null;
  let attempts = 0;
  let signature = "";

  const connect = () => {
    if (stopped) return;
    const parameters = new URLSearchParams({ role });
    Object.entries(identity()).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== "") parameters.set(key, String(value));
    });
    signature = parameters.toString();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/ws/live?${signature}`);
    socket.addEventListener("open", () => {
      attempts = 0;
      onConnectionChange(true);
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "snapshot") onSnapshot(message.data);
    });
    socket.addEventListener("close", () => {
      onConnectionChange(false);
      if (stopped) return;
      attempts += 1;
      retryTimer = setTimeout(connect, Math.min(5000, 250 * (2 ** Math.min(attempts, 4))));
    });
    socket.addEventListener("error", () => socket.close());
  };

  connect();
  return {
    refresh() {
      const parameters = new URLSearchParams({ role });
      Object.entries(identity()).forEach(([key, value]) => {
        if (value !== null && value !== undefined && value !== "") parameters.set(key, String(value));
      });
      if (parameters.toString() !== signature) socket?.close();
    },
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      socket?.close();
    }
  };
}

