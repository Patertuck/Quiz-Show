import { publishStandby } from "../presentation-host.js";

export function mount() {
  publishStandby().catch(() => undefined);
}
