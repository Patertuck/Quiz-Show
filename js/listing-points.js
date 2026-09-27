export function listingPlacementPoints(teamCount) {
  if (!Number.isInteger(teamCount) || teamCount <= 0) return [];
  return Array.from({ length: teamCount }, (_, index) => (teamCount - index - 1) * 100);
}
