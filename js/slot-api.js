let activeInstanceName = null;

export function setActiveInstanceName(name) {
  activeInstanceName = typeof name === "string" && name ? name : null;
}

export function slotUrl(path) {
  if (!activeInstanceName) return path;
  const url = new URL(path, window.location.origin);
  url.searchParams.set("instance", activeInstanceName);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function hostFetch(path, options) {
  return fetch(slotUrl(path), options);
}
