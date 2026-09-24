export const TEAM_COLORS = [
  { id: "sun", label: "Sonnengelb", value: "#ffdd3c", text: "#17206a" },
  { id: "cyan", label: "Cyan", value: "#4de3ff", text: "#17206a" },
  { id: "rose", label: "Rosa", value: "#ff6384", text: "#17206a" },
  { id: "green", label: "Grün", value: "#70e36b", text: "#17206a" },
  { id: "violet", label: "Violett", value: "#bd7cff", text: "#17206a" },
  { id: "orange", label: "Orange", value: "#ff9f43", text: "#17206a" },
  { id: "blue", label: "Blau", value: "#45a3ff", text: "#17206a" },
  { id: "pink", label: "Pink", value: "#f368e0", text: "#17206a" },
  { id: "lime", label: "Limette", value: "#a3e635", text: "#17206a" },
  { id: "coral", label: "Koralle", value: "#ff6b35", text: "#17206a" },
  { id: "mint", label: "Mint", value: "#55efc4", text: "#17206a" },
  { id: "lavender", label: "Lavendel", value: "#c7d2fe", text: "#17206a" }
];

export function teamColor(id, fallbackIndex = 0) {
  return TEAM_COLORS.find((color) => color.id === id) || TEAM_COLORS[fallbackIndex % TEAM_COLORS.length];
}

export function applyTeamColor(element, id, fallbackIndex = 0) {
  const color = teamColor(id, fallbackIndex);
  element.style.setProperty("--team-color", color.value);
  element.style.setProperty("--team-color-text", color.text);
  return color;
}
