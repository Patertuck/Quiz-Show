import { formatInteger } from "./format-number.js";

const GAME_TITLES = {
  jeopardy: "Jeopardy",
  ordering: "Order Up",
  listing: "List It",
  sync: "Sync Up"
};

function formatPoints(value) {
  return `${formatInteger(value)} Punkte`;
}

export function buildGameRules(gameId, config) {
  if (gameId === "jeopardy") {
    const values = config.games.jeopardy.values;
    return {
      gameId,
      title: GAME_TITLES[gameId],
      summary: "Wählt ein Feld, hört gut zu und buzzert, sobald ihr die Antwort wisst.",
      steps: [
        "Ein Team wählt eine Kategorie und einen Punktewert.",
        "Sobald die Spielleitung den Buzzer freigibt, darf jedes Team buzzern.",
        "Eine richtige Antwort bringt den Feldwert, eine falsche Antwort zieht ihn ab."
      ],
      graphic: { kind: "jeopardy", values: [values[0], values.at(-1)] }
    };
  }
  if (gameId === "ordering") {
    const game = config.games.ordering;
    const relative = (game.scoringMode || "relative") === "relative";
    return {
      gameId,
      title: GAME_TITLES[gameId],
      summary: "Bringt die vorgegebenen Elemente auf eurem Handy in die richtige Reihenfolge.",
      steps: [
        "Zieht die Karten vor Ablauf der Zeit an die richtige Position.",
        "Die zuletzt gespeicherte Reihenfolge wird automatisch gewertet.",
        relative
          ? `Jedes mögliche Kartenpaar wird einzeln verglichen: Stehen beide Karten relativ zueinander richtig, erhaltet ihr ${formatPoints(game.pointsPerCorrect)} – auch wenn sie nicht an der exakten Position liegen.`
          : `Für jede exakt richtige Position erhaltet ihr ${formatPoints(game.pointsPerCorrect)}.`
      ],
      graphic: {
        kind: "ordering",
        scoringMode: relative ? "relative" : "exact",
        pointsPerCorrect: game.pointsPerCorrect
      }
    };
  }
  if (gameId === "listing") {
    const example = config.games.listing.questions[0];
    const distributionsVary = config.games.listing.questions.some((question) => (
      question.placementPoints.join(",") !== example.placementPoints.join(",")
    ));
    return {
      gameId,
      title: GAME_TITLES[gameId],
      summary: "Sammelt als Team möglichst viele unterschiedliche, gültige Begriffe.",
      steps: [
        "Gebt eure Begriffe vor Ablauf der Zeit auf dem Team-Handy ein.",
        "Doppelte Begriffe zählen nur einmal; ungültige Antworten können abgelehnt oder mit einem Minuspunkt gewertet werden.",
        "Die Teams werden nach der Zahl ihrer gültigen Begriffe platziert."
      ],
      graphic: {
        kind: "podium",
        label: distributionsVary ? `Beispiel: ${example.title}` : "Platzierungspunkte",
        points: example.placementPoints,
        note: distributionsVary ? "Die Punkteverteilung wird vor jeder Aufgabe angezeigt." : null
      }
    };
  }
  if (gameId === "sync") {
    const game = config.games.sync;
    return {
      gameId,
      title: GAME_TITLES[gameId],
      summary: "Wie gut seid ihr als Team auf derselben Wellenlänge?",
      steps: [
        "Jede Person registriert sich mit dem eigenen Namen in ihrem Team.",
        "Bei jedem Prompt wählt ihr heimlich eine Person aus eurem eigenen Team.",
        `Wählt das ganze Team dieselbe Person, erhält es ${formatPoints(game.pointsPerSync)}.`
      ],
      graphic: { kind: "sync", points: game.pointsPerSync }
    };
  }
  throw new Error("Unbekannter Spieltyp.");
}

function element(tag, className = "", text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}

function renderGraphic(graphic, onShowExample = null) {
  const area = element("div", `game-rules-graphic ${graphic.kind}`);
  if (graphic.kind === "jeopardy") {
    area.append(
      element("span", "rules-tile", formatInteger(graphic.values[0])),
      element("span", "rules-buzzer", "BUZZ"),
      element("span", "rules-tile", formatInteger(graphic.values[1]))
    );
  } else if (graphic.kind === "ordering") {
    area.append(element("span", "rules-ordering-example-hint", "Beispiel: Alter – älteste Person zuerst"));
  } else if (graphic.kind === "podium") {
    area.append(element("strong", "rules-graphic-label", graphic.label));
    const podium = element("div", "rules-podium");
    graphic.points.forEach((points, index) => {
      const place = element("div", `rules-podium-place place-${index + 1}`);
      place.append(element("span", "", `${index + 1}.`), element("strong", "", formatInteger(points)));
      podium.append(place);
    });
    area.append(podium);
    if (graphic.note) area.append(element("small", "", graphic.note));
  } else if (graphic.kind === "sync") {
    const votes = element("div", "rules-sync-votes");
    ["●", "●", "●"].forEach((value) => votes.append(element("span", "", value)));
    area.append(votes, element("span", "rules-sync-arrow", "→"), element("strong", "rules-sync-result", `+${formatInteger(graphic.points)}`));
  }
  const show = element("button", `secondary-button rules-example-toggle rules-${graphic.kind}-example-toggle`, "Beispiel auf Display zeigen");
  show.type = "button";
  show.addEventListener("click", async () => {
    show.disabled = true;
    try {
      await onShowExample?.();
      show.textContent = "Beispiel wird angezeigt";
    } catch (error) {
      show.textContent = "Erneut versuchen";
      console.error("Spielbeispiel konnte nicht angezeigt werden:", error);
    } finally {
      show.disabled = false;
    }
  });
  area.append(show);
  return area;
}

export function renderGameRules(model, { actionLabel = null, onAction = null, onBack = null, onShowExample = null } = {}) {
  const screen = element("section", `game-rules-screen game-rules-${model.gameId}`);
  const panel = element("div", "game-rules-panel");
  const eyebrow = element("p", "game-rules-eyebrow", "So wird gespielt");
  const title = element("h1", "", model.title);
  const summary = element("p", "game-rules-summary", model.summary);
  const steps = element("ol", "game-rules-steps");
  model.steps.forEach((step) => steps.append(element("li", "", step)));
  panel.append(eyebrow, title, summary, renderGraphic(model.graphic, onShowExample), steps);
  if (actionLabel && onAction) {
    const actions = element("div", "game-rules-actions");
    if (onBack) {
      const back = element("button", "secondary-button", "Zurück zur Spielauswahl");
      back.type = "button";
      back.addEventListener("click", onBack);
      actions.append(back);
    }
    const action = element("button", "primary-button", actionLabel);
    action.type = "button";
    action.addEventListener("click", () => onAction(action));
    actions.append(action);
    panel.append(actions);
  }
  screen.append(panel);
  return screen;
}
