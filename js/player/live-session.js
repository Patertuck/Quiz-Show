import { createLiveConnection } from "../live-client.js";

export function connectPlayerSession(options) {
  return createLiveConnection({ role: "player", ...options });
}
