export function formatInteger(value) {
  if (!Number.isSafeInteger(value)) throw new TypeError("Only safe integers can be formatted.");
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.abs(value));
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, "'")}`;
}
