import { publishOrdering } from "../presentation-host.js";

export function mount() {
  publishOrdering().catch(() => undefined);
}
