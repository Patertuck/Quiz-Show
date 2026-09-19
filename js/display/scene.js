export function displaySceneKey(presentation, { ordering, listing, sync } = {}) {
  if (!presentation) return null;
  if (presentation.screen === "jeopardy-question") {
    return `${presentation.screen}:${presentation.question?.id}:${presentation.question?.answerRevealed ? "answer" : "question"}`;
  }
  if (presentation.screen === "ordering") {
    const round = ordering?.round;
    const view = !round ? "waiting" : round.phase === "active" ? "active" : "results";
    return `ordering:${round?.id || "none"}:${view}`;
  }
  if (presentation.screen === "listing") {
    const round = listing?.round;
    if (!round) return `listing:waiting:${presentation.questionSelection?.selectedQuestion?.id || "overview"}`;
    if (round.phase === "review") return `listing:${round.id}:review:${round.review?.index ?? 0}`;
    if (["results", "distributed"].includes(round.phase)) {
      const resultView = round.resultView;
      return `listing:${round.id}:results:${resultView?.mode || "ranking"}:${resultView?.teamPosition ?? 0}`;
    }
    return `listing:${round.id}:${round.phase}`;
  }
  if (presentation.screen === "team-lobby") return "team-lobby";
  if (presentation.screen === "sync") {
    const round = sync?.round;
    if (!sync?.rosterLocked) return "sync:lobby";
    if (!round) return "sync:waiting";
    const view = ["results", "distributed"].includes(round.phase) ? "results" : round.phase;
    return `sync:${round.id}:${view}`;
  }
  return presentation.screen;
}

export function scoreChanges(currentPresentation, nextPresentation) {
  return nextPresentation.teams.map((team, teamIndex) => ({
    teamIndex,
    points: team.score - (currentPresentation.teams[teamIndex]?.score ?? team.score),
    oldScore: currentPresentation.teams[teamIndex]?.score ?? team.score,
    newScore: team.score
  }));
}

export function manualScoreChanges(currentPresentation, nextPresentation) {
  const adjustment = nextPresentation?.scoreAdjustment;
  if (!currentPresentation || !adjustment || adjustment.id === currentPresentation.scoreAdjustment?.id) return [];
  const changes = scoreChanges(currentPresentation, nextPresentation).filter(({ points }) => points !== 0);
  if (changes.length !== 1) return [];
  const [change] = changes;
  return change.teamIndex === adjustment.teamIndex && change.points === adjustment.amount ? changes : [];
}
