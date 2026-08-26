export function usesQuickTunnelPolling() {
  return location.hostname.toLocaleLowerCase().endsWith(".trycloudflare.com");
}

export function startLivePolling({ query = () => ({}), onSnapshot, onConnectionChange = () => {} }) {
  let stopped = false;
  let timer = null;
  let failures = 0;
  let controller = null;

  const schedule = (delay) => {
    if (!stopped) timer = setTimeout(poll, delay);
  };

  const poll = async () => {
    controller = new AbortController();
    const parameters = new URLSearchParams();
    Object.entries(query()).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== "") parameters.set(key, String(value));
    });
    try {
      const response = await fetch(`/api/live-state?${parameters}`, {
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot = await response.json();
      failures = 0;
      onConnectionChange(true);
      onSnapshot(snapshot);
      schedule(750);
    } catch (error) {
      if (stopped || error.name === "AbortError") return;
      failures += 1;
      onConnectionChange(false);
      schedule(Math.min(5000, 750 * (2 ** Math.min(failures, 3))));
    }
  };

  poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
  };
}
