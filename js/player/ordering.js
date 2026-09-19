export function moveOrder(order, from, to) {
  if (from === to || to < 0 || to >= order.length) return order;
  const result = [...order];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}
