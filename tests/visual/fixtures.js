export const teamNames = [
  "Die unglaublich schnellen Roten", "Team Blau", "Goldene Genies",
  "Violette Visionäre", "Grüne Giganten", "Orange Originale"
];

const questions = Array.from({ length: 6 }, (_, index) => ({
  id: `q-${index + 1}`,
  title: `Aufgabe ${index + 1} mit einem längeren Titel`,
  prompt: "Bringt alle Begriffe in die richtige Reihenfolge, auch wenn die Aufgabenbeschreibung mehrere Zeilen benötigt.",
  timeLimitSeconds: 30,
  items: ["Sehr langer erster Begriff", "Zweiter Begriff", "Dritter Begriff", "Vierter Begriff", "Fünfter Begriff"]
}));

export const config = {
  title: "Die grosse responsive Quizshow",
  teams: teamNames.map((name) => ({ name, startingScore: 0 })),
  games: {
    jeopardy: {
      values: [100, 200, 300, 400, 500],
      categories: Array.from({ length: 6 }, (_, category) => ({
        name: `Kategorie ${category + 1} mit langem Namen`,
        questions: Array.from({ length: 5 }, (_, row) => ({
          question: `Eine ausführliche Frage aus Kategorie ${category + 1}, Zeile ${row + 1}, die sauber skaliert werden muss?`,
          answer: "Eine ebenfalls ausführliche Musterantwort"
        }))
      }))
    },
    ordering: { scoringMode: "relative", pointsPerCorrect: 50, questions },
    listing: { questions: questions.map((question, index) => ({
      ...question, displayCategory: `Kategorie ${index + 1} mit langem Namen`,
      maxItems: 20, placementPoints: [300, 200, 100]
    })) },
    sync: { timeLimitSeconds: 8, pointsPerSync: 100, questions }
  }
};

export const logos = {
  main: "/assets/Logos/logo_Quiz.png", jeopardy: "/assets/Logos/Logo_Jeopardy.png",
  ordering: "/assets/Logos/Logo_Order_Up.png", listing: "/assets/Logos/Logo_List_It.png",
  sync: "/assets/Logos/Logo_Sync_Up.png"
};

export const teams = teamNames.map((name, index) => ({ name, score: (5 - index) * 100 }));
export const basePresentation = { version: 1, serverSessionId: "visual-tests", title: config.title, teams, logos,
  audioSettings: { effectsEnabled: false, tensionMusicEnabled: false, ambientMusicEnabled: false } };

export const selection = {
  questions: questions.map((question, index) => ({ id: question.id, title: question.title, displayCategory: `Kategorie ${index + 1} mit langem Namen`, completed: index === 5 })),
  highlightedQuestionId: "q-2", selectedQuestion: null
};

const orderItems = questions[0].items.map((text, index) => ({ id: `item-${index}`, text }));
export const orderingBase = { version: 3, teams: teamNames, teamsRevision: "visual", completedQuestionIds: ["q-6"], connectedTeamCount: 6, round: null };
export const orderingActive = { ...orderingBase, round: {
  id: "ordering-round", questionId: "q-1", title: questions[0].title, prompt: questions[0].prompt,
  timeLimitSeconds: 30, deadlineAt: Date.now() + 25_000, phase: "active", scoringMode: "relative",
  pointsPerCorrect: 50, shuffledItems: orderItems, correctItems: orderItems,
  teamOrders: teamNames.map((_, index) => index % 2
    ? [...orderItems].reverse().map((item) => item.id)
    : orderItems.map((item) => item.id)),
  revealed: [], pointsRevealed: false
} };
export const orderingResults = { ...orderingBase, round: {
  ...orderingActive.round, phase: "distributed", revealed: [0, 1, 2, 3, 4], pointsRevealed: true,
  correctItems: orderItems, revealedItems: orderItems,
  teamOrders: teamNames.map((_, index) => index % 2 ? [...orderItems].reverse().map((item) => item.id) : orderItems.map((item) => item.id)),
  rowPoints: teamNames.map((_, index) => orderItems.map(() => index % 2 ? 0 : 50)),
  roundPoints: teamNames.map((_, index) => index % 2 ? 0 : 250)
} };

const listingItems = Array.from({ length: 18 }, (_, index) => ({ text: `Eingereichter Begriff Nummer ${index + 1}`, status: ["counted", "duplicate", "rejected"][index % 3] }));
export const listingBase = { version: 3, teams: teamNames, teamsRevision: "visual", completedQuestionIds: ["q-6"], connectedTeamCount: 6, round: null };
export const listingActive = { ...listingBase, round: {
  id: "listing-round", questionId: "q-1", title: questions[0].title, prompt: questions[0].prompt,
  phase: "active", deadlineAt: Date.now() + 35_000, submittedCount: 4, maxItems: 20,
  submitted: teamNames.map((_, index) => index < 4),
  drafts: teamNames.map((_, teamIndex) => listingItems.slice(0, teamIndex + 2).map(({ text }) => text))
} };
export const listingReview = { ...listingBase, round: {
  ...listingActive.round, phase: "review", review: {
    teamIndex: 0, teamPosition: 0, teamTotal: 6, decidedCount: 7, total: 28,
    teamDecidedCount: 7, teamItemCount: 12,
    teams: teamNames.map((_, teamIndex) => ({ teamIndex, itemCount: teamIndex + 7, decidedCount: teamIndex ? teamIndex : 7 })),
    items: Array.from({ length: 12 }, (_, index) => ({
      itemId: `t0-i${index}`,
      text: index === 2 ? "Ein aussergewöhnlich langer eingereichter Begriff" : `Antwort ${index + 1}`,
      decision: index < 4 ? 1 : index < 6 ? 0 : index === 6 ? -1 : null
    }))
  }
} };
export const listingResults = { ...listingBase, round: {
  ...listingActive.round, phase: "results", resultView: { mode: "ranking", teamPosition: 0 },
  results: teamNames.map((_, teamIndex) => ({ teamIndex, place: teamIndex + 1, acceptedCount: 18 - teamIndex, points: Math.max(0, 300 - teamIndex * 50), items: listingItems }))
} };

export const participants = teamNames.flatMap((_, teamIndex) => Array.from({ length: 3 }, (_, index) => ({
  id: `person-${teamIndex}-${index}`, name: `Person ${teamIndex + 1}.${index + 1} mit langem Namen`, teamIndex, deviceId: `device-${teamIndex}-${index}`
})));
export const syncLobby = { version: 2, teams: teamNames, rosterLocked: false, participants, connectedParticipantIds: participants.map(({ id }) => id), round: null };
export const syncActive = { ...syncLobby, rosterLocked: true, round: {
  id: "sync-round", questionId: "q-1", prompt: questions[0].prompt, phase: "active", deadlineAt: Date.now() + 7_000,
  timeLimitSeconds: 8, submittedCount: 12
} };
export const syncResults = { ...syncLobby, rosterLocked: true, round: {
  ...syncActive.round, phase: "results", results: teamNames.map((_, teamIndex) => ({
    teamIndex, synced: teamIndex % 2 === 0, points: teamIndex % 2 === 0 ? 100 : 0,
    votes: participants.filter((person) => person.teamIndex === teamIndex).map((person, index, members) => ({ participantId: person.id, selectedParticipantId: members[(index + 1) % members.length].id }))
  }))
} };

export const teamLobby = { version: 1, phase: "open", maxTeams: 12, selectedTeamId: "team-0", ownedTeamId: null,
  teams: teamNames.map((name, index) => ({ id: `team-${index}`, name, memberCount: index + 1 })) };
export const buzzer = { version: 1, teams: teamNames, teamsRevision: "visual", round: { id: "buzz", questionId: "0:0", open: true,
  buzzes: teamNames.map((name, teamIndex) => ({ teamIndex, teamName: name })), activeTeamIndex: 0 } };

export function liveSnapshot(presentation = { ...basePresentation, screen: "hub", games: Object.keys(config.games), highlightedGame: "ordering" }, overrides = {}) {
  return {
    session: { revision: 1, phase: "running", teams }, presentation, teamLobby, buzzer,
    ordering: orderingBase, listing: listingBase, sync: syncLobby, ...overrides
  };
}
