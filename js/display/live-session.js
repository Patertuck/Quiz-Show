import { createLiveConnection } from "../live-client.js";

export function connectDisplaySession(options) {
  return createLiveConnection({ role: "display", ...options });
}
