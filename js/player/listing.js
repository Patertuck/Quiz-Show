export function appendUniqueItem(items, value) {
  const item = value.trim();
  if (!item) return { items, error: "empty" };
  if (items.some((candidate) => candidate.toLocaleLowerCase() === item.toLocaleLowerCase())) {
    return { items, error: "duplicate" };
  }
  return { items: [...items, item], error: null };
}
