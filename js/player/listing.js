export function appendUniqueItem(items, value, maxItems) {
  const item = value.trim();
  if (!item) return { items, error: "empty" };
  if (items.some((candidate) => candidate.toLocaleLowerCase() === item.toLocaleLowerCase())) {
    return { items, error: "duplicate" };
  }
  if (items.length >= maxItems) return { items, error: "full" };
  return { items: [...items, item], error: null };
}
