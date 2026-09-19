const cache = new Map();

export function loadTemplate(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(path, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`${path} konnte nicht geladen werden (HTTP ${response.status}).`);
      return response.text();
    }));
  }
  return cache.get(path);
}

