let activeSlotId = null;

export function setActiveSlotId(slotId) {
  activeSlotId = typeof slotId === "string" && slotId ? slotId : null;
}

export function slotUrl(path) {
  if (!activeSlotId) return path;
  const url = new URL(path, window.location.origin);
  url.searchParams.set("slot", activeSlotId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function hostFetch(path, options) {
  return fetch(slotUrl(path), options);
}
