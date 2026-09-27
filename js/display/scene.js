export function displaySceneKey(presentation, { ordering, listing, sync } = {}) {
  if (!presentation) return null;
  if (presentation.screen === "rules-example") return `rules-example:${presentation.example?.gameId}`;
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

export function jeopardyTransitionPlan(previousScreen, previousQuestionId, nextPresentation) {
  if (previousScreen === "jeopardy-board" && nextPresentation?.screen === "jeopardy-question") {
    return { direction: "opening", tileId: nextPresentation.question?.id };
  }
  if (previousScreen === "jeopardy-question" && nextPresentation?.screen === "jeopardy-board") {
    return { direction: "closing", tileId: previousQuestionId };
  }
  return null;
}

export function gameTransitionPlan(previousScreen, nextScreen) {
  const gameForScreen = (screen) => {
    if (["jeopardy-board", "jeopardy-question"].includes(screen)) return "jeopardy";
    return ["ordering", "listing", "sync"].includes(screen) ? screen : null;
  };
  if (previousScreen === "hub") {
    const gameId = gameForScreen(nextScreen);
    return gameId ? { direction: "opening", gameId } : null;
  }
  if (nextScreen === "hub") {
    const gameId = gameForScreen(previousScreen);
    return gameId ? { direction: "closing", gameId } : null;
  }
  return null;
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
