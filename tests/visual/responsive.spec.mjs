import { test, expect } from "@playwright/test";
import { expectNoViewportOverflow, expectVisibleControlsUsable } from "./layout.js";
import {
  basePresentation, buzzer, config, listingActive, listingBase, listingResults, listingReview, liveSnapshot,
  orderingActive, orderingBase, orderingResults, participants, selection, syncActive, syncLobby, syncResults,
  teamLobby, teamNames
} from "./fixtures.js";
import { displayPresentation, mockHost, mockLiveSocket, mockPlayer, playerSnapshot } from "./mock-app.js";

const desktopViewports = [{ width: 1280, height: 720 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }];

async function verify(page, name, { phone = false, screenshot = true, allowVerticalScroll = phone } = {}) {
  await expect(page.locator("body")).toBeVisible();
  await expectNoViewportOverflow(page, { allowVerticalScroll });
  await expectVisibleControlsUsable(page, phone ? 40 : 30, { allowOffscreen: allowVerticalScroll });
  if (screenshot) {
    if (await page.locator("video").count()) {
      await expect(page.locator("video").first()).toHaveCSS("opacity", "1");
    }
    await page.locator("video").evaluateAll(async (videos) => Promise.all(videos.map(async (video) => {
      video.pause();
      if (video.readyState < 2) await new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true }));
      video.currentTime = 0;
      await new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
    })));
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: phone });
  }
}

const hostCases = [
  ["master", "master", {}], ["intro", "start", {}], ["team-setup", "setup", {}], ["hub", "hub", {}],
  ["jeopardy-board", "jeopardy", {}],
  ["jeopardy-question", "jeopardy", { activeQuestion: { categoryIndex: 0, rowIndex: 0, answerRevealed: false } }],
  ["jeopardy-buzzer-waiting", "jeopardy", {
    activeQuestion: { categoryIndex: 0, rowIndex: 0, answerRevealed: false },
    buzzer: { ...buzzer, round: { ...buzzer.round, buzzes: [], activeTeamIndex: null } }
  }],
  ["jeopardy-buzzer-closed", "jeopardy", {
    activeQuestion: { categoryIndex: 0, rowIndex: 0, answerRevealed: false },
    buzzer: { ...buzzer, round: { ...buzzer.round, open: false, buzzes: [], activeTeamIndex: null } }
  }],
  ["ordering-overview", "ordering", { ordering: orderingBase }],
  ["ordering-preview", "ordering", { ordering: orderingBase }, async (page) => page.locator(".ordering-question-card").first().click()],
  ["ordering-active", "ordering", { ordering: orderingActive }],
  ["ordering-results", "ordering", { ordering: orderingResults }],
  ["listing-overview", "listing", { listing: listingBase }],
  ["listing-active", "listing", { listing: listingActive }],
  ["listing-review", "listing", { listing: listingReview }],
  ["listing-results", "listing", { listing: listingResults }],
  ["sync-lobby", "sync", { sync: syncLobby }], ["sync-active", "sync", { sync: syncActive }],
  ["sync-results", "sync", { sync: syncResults }], ["victory", "victory", {}]
];

const hostRouteSelectors = {
  master: "#master-view", start: "#start-view", setup: "#setup-view", hub: "#hub-view",
  jeopardy: "#jeopardy-view", ordering: "#ordering-view", listing: "#listing-view",
  sync: "#sync-view", victory: "#victory-view"
};

for (const viewport of desktopViewports) {
  for (const [name, route, fixture, prepare] of hostCases) {
    test(`host ${name} fits ${viewport.width}x${viewport.height}`, async ({ page }) => {
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.setViewportSize(viewport);
      await mockHost(page, fixture);
      await page.goto(`/#/${route}`);
      await expect(page.locator(hostRouteSelectors[route])).toBeVisible();
      if (prepare) await prepare(page);
      await expect(page.getByText("Quizfehler", { exact: true })).toHaveCount(0);
      await verify(page, `host-${name}`, {
        allowVerticalScroll: route === "master", screenshot: viewport.width === 1280
      });
      if (name === "ordering-results") {
        await expect(page.locator(".ordering-row-points").first()).toHaveCSS("animation-name", "none");
      }
      expect(pageErrors).toEqual([]);
    });
  }
}

test("host ordering preview keeps its actions visible at short desktop height", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 500 });
  await mockHost(page, { ordering: orderingBase });
  await page.goto("/#/ordering");
  await page.locator(".ordering-question-card").first().click();
  await expect(page.getByRole("button", { name: "Starten", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Zurück", exact: true })).toBeInViewport();
  await expect(page.locator(".ordering-preview")).not.toHaveCSS("overflow-y", "auto");
  expect(await page.locator(".ordering-preview").evaluate((element) => {
    const transform = getComputedStyle(element).transform;
    return transform !== "none" && Number(transform.split("(")[1].split(",")[0]) < 1;
  })).toBe(true);
  await expectVisibleControlsUsable(page, 30);
});

test("host can publish the Order Up scoring example from the rules", async ({ page }) => {
  const presentations = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/presentation/state" && request.method() === "PUT") {
      presentations.push(request.postDataJSON());
    }
  });
  await mockHost(page, { ordering: orderingBase });
  await page.goto("/#/ordering");
  await page.locator("#ordering-rules-button").click();
  const toggle = page.locator(".rules-ordering-example-toggle");
  await expect(toggle).toHaveText("Beispiel auf Display zeigen");
  await toggle.click();
  await expect(toggle).toHaveText("Beispiel wird angezeigt");
  await expect.poll(() => presentations.find((item) => item.scoringExample)).toMatchObject({
    screen: "ordering",
    scoringExample: { scoringMode: "relative", pointsPerCorrect: 50 }
  });
});

test("audience display renders a clear Order Up scoring example", async ({ page }) => {
  const presentation = displayPresentation("ordering", {
    questionSelection: null,
    orderingMap: null,
    scoringExample: { scoringMode: "relative", pointsPerCorrect: 50 }
  });
  await mockLiveSocket(page, liveSnapshot(presentation, { ordering: orderingBase }));
  await page.goto("/display.html");
  await expect(page.locator(".display-ordering-example-card")).toBeVisible();
  await expect(page.getByText("Anna", { exact: true })).toHaveCount(2);
  await expect(page.getByText("2 von 3 Paaren richtig", { exact: false })).toBeVisible();
  await expectNoViewportOverflow(page);
});

test("team names save on Enter without separate save buttons", async ({ page }) => {
  const renameRequests = [];
  await mockHost(page);
  await page.route("**/api/team-lobby/control**", async (route) => {
    const payload = route.request().postDataJSON();
    if (payload.action === "rename") renameRequests.push(payload);
    const nextLobby = payload.action === "rename"
      ? { ...teamLobby, teams: teamLobby.teams.map((team) => team.id === payload.teamId ? { ...team, name: payload.name } : team) }
      : teamLobby;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(nextLobby) });
  });
  await page.goto("/#/setup");
  await expect(page.getByRole("button", { name: "Speichern", exact: true })).toHaveCount(0);
  const input = page.locator(".team-name-editor").first();
  await input.fill("Die Schnelleren");
  await input.press("Enter");
  await expect.poll(() => renameRequests.length).toBe(1);
  expect(renameRequests[0]).toMatchObject({ action: "rename", name: "Die Schnelleren" });
  await expect(page.locator(".team-name-status").first()).toHaveText("Gespeichert");
});

test("host team colors stay compact until opened", async ({ page }) => {
  await mockHost(page);
  await page.goto("/#/setup");
  const picker = page.locator(".team-color-picker").first();
  await expect(picker.locator(".team-color-options")).toBeHidden();
  await picker.locator(".team-color-trigger").click();
  await expect(picker.locator(".team-color-options")).toBeVisible();
  await expect(picker.locator(".team-color-choice")).toHaveCount(12);
  await expect(picker.locator(".team-color-choice:disabled")).toHaveCount(teamLobby.teams.length - 1);
  expect(await picker.locator(".team-color-choice:disabled").first().evaluate((element) =>
    getComputedStyle(element, "::after").content)).toContain("🔒");
});

test("active game setup publishes the team lobby to the audience display", async ({ page }) => {
  const presentations = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/presentation/state" && request.method() === "PUT") {
      presentations.push(request.postDataJSON());
    }
  });
  await mockHost(page, { lobby: { ...teamLobby, phase: "locked" } });
  await page.goto("/#/setup");
  await expect(page.locator("#setup-view")).toBeVisible();
  await expect.poll(() => presentations.find((presentation) => presentation.screen === "team-lobby"))
    .toMatchObject({ screen: "team-lobby", joinUrl: "http://quiz.local/player" });
});

test("phone team color picker renders the selected color and palette", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockPlayer(page, playerSnapshot(displayPresentation("team-lobby", {
    joinUrl: "http://quiz.local/player"
  }), { teamLobby }));
  await page.goto("/player.html");
  const picker = page.locator(".team-lobby-phone-colors");
  const trigger = picker.locator(".team-lobby-color-trigger");
  await expect(trigger).toHaveCSS("background-color", "rgb(255, 221, 60)");
  await trigger.click();
  await expect(picker.locator(".team-lobby-color-options")).toBeVisible();
  await expect(picker.locator(".team-lobby-color-options button").nth(1))
    .toHaveCSS("background-color", "rgb(77, 227, 255)");
  expect(await picker.locator(".team-lobby-color-options button:disabled").first().evaluate((element) =>
    getComputedStyle(element, "::after").content)).toContain("🔒");
});

test("Sync Up phone separates team selection from personal naming", async ({ page }) => {
  await mockPlayer(page, playerSnapshot(displayPresentation("sync"), { sync: syncLobby }));
  await page.goto("/player.html");
  await expect(page.locator("#sync-team-selection")).toBeVisible();
  await expect(page.locator("#sync-name-selection")).toBeHidden();
  await page.locator("#sync-team-choices button").first().click();
  await expect(page.locator("#sync-team-selection")).toBeHidden();
  await expect(page.locator("#sync-name-selection")).toBeVisible();
});

test("joined Sync Up players get separate edit actions", async ({ page }) => {
  const joined = { ...syncLobby, selfParticipantId: participants[0].id };
  await mockPlayer(page, playerSnapshot(displayPresentation("sync"), { sync: joined }));
  await page.goto("/player.html");
  await expect(page.locator("#sync-member-actions button")).toHaveCount(3);
  await expect(page.locator("#sync-member-actions")).toBeVisible();
  await page.locator("#sync-show-team-rename").click();
  await expect(page.locator("#sync-team-rename-form")).toBeVisible();
});

test("Jeopardy buzzer distinguishes current team and waiting queue", async ({ page }) => {
  await mockHost(page, { activeQuestion: { categoryIndex: 0, rowIndex: 0, answerRevealed: false } });
  await page.goto("/#/jeopardy");
  await expect(page.locator("#buzzer-panel")).toHaveAttribute("data-state", "buzzed");
  await expect(page.locator("#buzzer-active-team")).toHaveText(teamNames[0]);
  await expect(page.locator("#buzz-order li")).toHaveCount(teamNames.length - 1);
  await expect(page.locator(".buzz-position").first()).toHaveText("2");
});

test("host can inspect a Jeopardy solution without publishing it", async ({ page }) => {
  const longAnswer = Array.from({ length: 12 }, (_, index) =>
    `Abschnitt ${index + 1} erklärt ausführlich einen wichtigen Teil der Musterlösung.`).join(" ");
  const quizConfig = structuredClone(config);
  quizConfig.games.jeopardy.categories[0].questions[0].answer = longAnswer;
  const presentationUpdates = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/presentation/state" && request.method() === "POST") {
      presentationUpdates.push(request.postDataJSON());
    }
  });
  await mockHost(page, { activeQuestion: { categoryIndex: 0, rowIndex: 0, answerRevealed: false }, quizConfig });
  await page.goto("/#/jeopardy");
  const toggle = page.locator("#private-solution-button");
  await expect(toggle).toHaveText("Lösung ansehen");
  const updatesBeforeOpening = presentationUpdates.length;
  await toggle.click();
  await expect(toggle).toHaveText("Frage ansehen");
  await expect(page.locator("#jeopardy-private-solution-label")).toBeVisible();
  await expect(page.locator("#answer-content")).toContainText(longAnswer);
  await expect(page.locator("#question-content")).toBeHidden();
  await expect(page.locator("#reveal-button")).toHaveText("Antwort anzeigen");
  await expectNoViewportOverflow(page);
  await expect.poll(() => page.locator("#answer-content").evaluate((element) => {
    const card = element.closest("#card-content").getBoundingClientRect();
    const answer = element.getBoundingClientRect();
    return answer.top >= card.top - 1 && answer.bottom <= card.bottom + 1;
  })).toBe(true);
  expect(presentationUpdates).toHaveLength(updatesBeforeOpening);
});

test("host can inspect a locked Order Up solution without revealing a position", async ({ page }) => {
  const lockedOrdering = {
    ...orderingActive,
    round: { ...orderingActive.round, phase: "locked", revealed: [], pointsRevealed: false }
  };
  const controlRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/ordering/control") controlRequests.push(request.postDataJSON());
  });
  const live = await mockHost(page, { ordering: lockedOrdering });
  await page.goto("/#/ordering");
  const toggle = page.locator(".ordering-private-solution-toggle");
  await expect(toggle).toHaveText("Lösung ansehen");
  const requestsBeforeOpening = controlRequests.length;
  await toggle.click();
  await expect(page.locator(".ordering-results")).toBeVisible();
  await expect(page.locator(".ordering-solution.private-preview .solution-cell"))
    .toHaveText(lockedOrdering.round.correctItems.map((item) => item.text));
  await expect(page.locator(".ordering-private-solution-toggle")).toHaveText("Ergebnisse ansehen");
  live.send(liveSnapshot(undefined, {
    ordering: { ...lockedOrdering, version: lockedOrdering.version + 1, connectedTeamCount: 5 }
  }));
  await expect(page.locator(".ordering-solution.private-preview")).toBeVisible();
  await page.locator(".ordering-private-solution-toggle").click();
  await expect(page.locator(".ordering-solution .solution-cell").first()).toHaveText("Position 1 aufdecken");
  await expectNoViewportOverflow(page);
  expect(controlRequests).toHaveLength(requestsBeforeOpening);
});

test("Order Up active peek keeps round controls available", async ({ page }) => {
  await mockHost(page, { ordering: orderingActive });
  await page.goto("/#/ordering");
  await page.locator(".ordering-private-solution-toggle").click();
  await expect(page.locator(".ordering-results")).toBeVisible();
  await expect(page.locator(".ordering-timer")).toHaveCount(0);
  await expect(page.locator(".ordering-solution.private-preview .solution-cell"))
    .toHaveText(orderingActive.round.correctItems.map((item) => item.text));
  await expect(page.getByRole("button", { name: "Antworten sperren" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Runde abbrechen" })).toBeVisible();
  await expect(page.locator(".ordering-private-solution-toggle")).toHaveText("Teams ansehen");
  await expectNoViewportOverflow(page);
});

const gameList = Object.keys(config.games);
const orderingSelection = { ...selection, selectedQuestion: { id: "q-1", title: selection.questions[0].title,
  prompt: config.games.ordering.questions[0].prompt, items: config.games.ordering.questions[0].items } };
const listingSelection = { ...selection, selectedQuestion: { id: "q-1", title: selection.questions[0].title,
  prompt: config.games.listing.questions[0].prompt } };
const displayCases = [
  ["standby", displayPresentation("standby")],
  ["team-lobby", displayPresentation("team-lobby", { joinUrl: "http://quiz.local/player" }), { teamLobby }],
  ["hub", displayPresentation("hub", { games: gameList, highlightedGame: "listing" })],
  ["jeopardy-board", displayPresentation("jeopardy-board", { board: { categories: config.games.jeopardy.categories.map(({ name }) => name), values: config.games.jeopardy.values, usedTiles: ["5:4"], highlightedTile: "2:2" } })],
  ["jeopardy-question", displayPresentation("jeopardy-question", { question: { id: "0:0", value: 500, question: config.games.jeopardy.categories[0].questions[0].question, questionImage: null, questionAudio: null, answerRevealed: false, answer: null, answerImage: null, answerAudio: null, audioCommand: null } }), { buzzer }],
  ["ordering-overview", displayPresentation("ordering", { questionSelection: selection, orderingMap: null }), { ordering: orderingBase }],
  ["ordering-preview", displayPresentation("ordering", { questionSelection: orderingSelection, orderingMap: null }), { ordering: orderingBase }],
  ["ordering-active", displayPresentation("ordering", { questionSelection: null, orderingMap: null }), { ordering: orderingActive }],
  ["ordering-results", displayPresentation("ordering", { questionSelection: null, orderingMap: null }), { ordering: orderingResults }],
  ["listing-overview", displayPresentation("listing", { questionSelection: selection }), { listing: listingBase }],
  ["listing-preview", displayPresentation("listing", { questionSelection: listingSelection }), { listing: listingBase }],
  ["listing-active", displayPresentation("listing", { questionSelection: null }), { listing: listingActive }],
  ["listing-review", displayPresentation("listing", { questionSelection: null }), { listing: listingReview }],
  ["listing-results", displayPresentation("listing", { questionSelection: null }), { listing: listingResults }],
  ["sync-lobby", displayPresentation("sync"), { sync: syncLobby }],
  ["sync-active", displayPresentation("sync"), { sync: syncActive }],
  ["sync-results", displayPresentation("sync"), { sync: syncResults }],
  ["victory", displayPresentation("victory", { steps: teamNames.map((name, index) => ({ kind: index < 3 ? "podium" : "standing", rank: index + 1, names: name, score: 600 - index * 100 })), revealedCount: 6 })]
];

test("display standby keeps the transparent logo still over the animated background", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await mockLiveSocket(page, liveSnapshot(displayPresentation("standby")));
  await page.goto("/display.html");
  await expect(page.locator(".display-standby-video")).toHaveCount(0);
  const result = await page.locator(".display-standby-logo").evaluate(async (logo) => {
    await logo.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(logo, 0, 0, 64, 64);
    const pixels = context.getImageData(0, 0, 64, 64).data;
    const bounds = logo.getBoundingClientRect();
    return {
      cornerAlpha: pixels[3],
      centerAlpha: pixels[(32 * 64 + 32) * 4 + 3],
      animations: logo.getAnimations().length,
      fits: bounds.top >= 0 && bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
    };
  });
  expect(result.cornerAlpha).toBeLessThan(8);
  expect(result.centerAlpha).toBeGreaterThan(240);
  expect(result.animations).toBe(0);
  expect(result.fits).toBe(true);
  expect(await page.locator(".display-standby-ambient").evaluate(
    (element) => element.getAnimations({ subtree: true }).length
  )).toBeGreaterThan(0);
});

test("display animates a Jeopardy tile into its question and back", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 720 });
  const board = displayPresentation("jeopardy-board", {
    version: 10,
    board: {
      categories: config.games.jeopardy.categories.map(({ name }) => name),
      values: config.games.jeopardy.values,
      usedTiles: [],
      highlightedTile: "2:2"
    }
  });
  const live = await mockLiveSocket(page, liveSnapshot(board));
  await page.goto("/display.html");
  await expect(page.locator('.display-tile[data-tile-id="2:2"]')).toBeVisible();

  const question = displayPresentation("jeopardy-question", {
    version: 11,
    question: {
      id: "2:2", value: config.games.jeopardy.values[2], question: "Animationsfrage",
      questionImage: null, questionAudio: null, answerRevealed: false,
      answer: null, answerImage: null, answerAudio: null, audioCommand: null
    }
  });
  live.send(liveSnapshot(question));
  await expect(page.locator(".display-question.jeopardy-transition-target")).toBeVisible();
  await expect.poll(() => page.locator(".display-question").evaluate((node) => node.getAnimations().length)).toBeGreaterThan(0);
  live.send(liveSnapshot(question, { buzzer: { ...buzzer, version: 2 } }));
  await expect(page.locator(".display-question.jeopardy-transition-target")).toBeVisible();
  await expect(page.locator(".display-question.jeopardy-transition-target")).toHaveCount(0, { timeout: 1500 });

  live.send(liveSnapshot({ ...board, version: 12, board: { ...board.board, usedTiles: ["2:2"] } }));
  await expect(page.locator(".jeopardy-transition-overlay")).toBeVisible();
  await expect(page.locator(".jeopardy-transition-overlay")).toHaveCount(0, { timeout: 1500 });
  await expect(page.locator('.display-tile[data-tile-id="2:2"].used')).toBeVisible();
});

test("display expands a game logo when entering and shrinks it when returning", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 720 });
  const hub = displayPresentation("hub", { version: 20, games: gameList, highlightedGame: "ordering" });
  const live = await mockLiveSocket(page, liveSnapshot(hub));
  await page.goto("/display.html");
  await expect(page.locator('.display-hub-game[data-game="ordering"] img')).toBeVisible();

  const ordering = displayPresentation("ordering", { version: 21, questionSelection: selection, orderingMap: null });
  live.send(liveSnapshot(ordering));
  await expect(page.locator(".game-transition-logo")).toBeVisible();
  await expect.poll(() => page.locator(".game-transition-logo").evaluate((node) => node.getAnimations().length)).toBeGreaterThan(0);
  await expect(page.locator(".game-transition-logo")).toHaveCount(0, { timeout: 1500 });
  await expect(page.locator(".display-ordering")).toBeVisible();

  live.send(liveSnapshot({ ...hub, version: 22, highlightedGame: null }));
  const returningLogo = page.locator('.display-hub-game[data-game="ordering"] img');
  await expect(returningLogo).toBeVisible();
  await expect.poll(() => returningLogo.evaluate((node) => node.getAnimations().length)).toBeGreaterThan(0);
  await expect.poll(() => returningLogo.evaluate((node) => node.getAnimations().length), { timeout: 1500 }).toBe(0);
});

for (const viewport of desktopViewports) {
  for (const [name, presentation, overrides = {}] of displayCases) {
    test(`display ${name} fits ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mockLiveSocket(page, { session: {}, presentation, teamLobby, buzzer, ordering: orderingBase, listing: listingBase, sync: syncLobby, ...overrides });
      await page.goto("/display.html");
      await expect(page.locator(".display-screen")).toBeVisible();
      await verify(page, `display-${name}`, { screenshot: viewport.width === 1280 });
      if (name === "ordering-results") {
        await expect(page.locator(".display-ordering-row-points").first()).toHaveCSS("animation-name", "none");
      }
    });
  }
}

const playerCases = [
  ["waiting", playerSnapshot(displayPresentation("standby"), { teamLobby: { ...teamLobby, phase: "locked" }, buzzer: { ...buzzer, teams: [], round: null } })],
  ["team-lobby", playerSnapshot(displayPresentation("team-lobby", { joinUrl: "http://quiz.local/player" }), { teamLobby })],
  ["buzzer", playerSnapshot(displayPresentation("jeopardy-question", { question: { id: "0:0", value: 500, question: "Frage", answerRevealed: false } }))],
  ["ordering", playerSnapshot(displayPresentation("ordering"), { ordering: orderingActive })],
  ["listing", playerSnapshot(displayPresentation("listing"), { listing: listingActive })],
  ["sync-register", playerSnapshot(displayPresentation("sync"), { sync: syncLobby })],
  ["sync-vote", playerSnapshot(displayPresentation("sync"), { sync: syncActive })]
];

for (const viewport of [
  { width: 320, height: 568 }, { width: 360, height: 640 }, { width: 390, height: 844 },
  { width: 430, height: 932 }, { width: 844, height: 390 }
]) {
  for (const [name, snapshot] of playerCases) {
    test(`player ${name} works at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mockPlayer(page, snapshot);
      await page.goto("/player.html");
      await expect(page.locator(".player-card:not([hidden])")).toBeVisible();
      await verify(page, `player-${name}-${viewport.width}x${viewport.height}`, { phone: true, screenshot: viewport.width === 390 });
    });
  }
}

test("host scoreboard uses apostrophe grouping", async ({ page }) => {
  const hostTeams = teamNames.map((name, index) => ({ name, score: index ? 0 : 1_000 }));
  await mockHost(page, { hostTeams });
  await page.goto("/#/hub");
  await expect(page.locator("#team-score-0")).toHaveText("1'000");
});

test("display scoreboard uses apostrophe grouping", async ({ page }) => {
  const displayTeams = teamNames.map((name, index) => ({ name, score: index ? 0 : 1_000 }));
  const presentation = displayPresentation("hub", { teams: displayTeams, games: gameList, highlightedGame: null });
  await mockLiveSocket(page, { session: {}, presentation, teamLobby, buzzer, ordering: orderingBase, listing: listingBase, sync: syncLobby });
  await page.goto("/display.html");
  await expect(page.locator(".display-team-score").first()).toHaveText("1'000");
});

test("display team join highlight is not clipped at roster edges", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const presentation = displayPresentation("team-lobby", { joinUrl: "http://quiz.local/player" });
  await mockLiveSocket(page, { session: {}, presentation, teamLobby, buzzer, ordering: orderingBase, listing: listingBase, sync: syncLobby });
  await page.goto("/display.html");
  const roster = page.locator(".display-team-lobby-roster");
  const edgeTeam = page.locator(".display-team-lobby-team").last();
  await expect(roster).toHaveCSS("overflow", "visible");
  await edgeTeam.evaluate((element) => {
    element.classList.add("fresh-activity");
    element.style.animationDelay = "-320ms";
    element.style.animationPlayState = "paused";
  });
  await expect(edgeTeam).toHaveCSS("transform", "none");
  await expectNoViewportOverflow(page);
});

test("host toolbar stays open while crossing from the trigger to an option", async ({ page }) => {
  await mockHost(page);
  await page.goto("/#/hub");
  const trigger = page.locator("#host-options-button");
  const menu = page.locator(".host-option-items");
  await trigger.hover();
  await expect(menu).toBeVisible();
  const triggerBox = await trigger.boundingBox();
  const firstOption = menu.locator("button").first();
  const optionBox = await firstOption.boundingBox();
  if (!triggerBox || !optionBox) throw new Error("Host toolbar controls are not measurable.");
  await page.mouse.move(triggerBox.x + triggerBox.width / 2, triggerBox.y + triggerBox.height / 2);
  await page.mouse.move(optionBox.x + optionBox.width / 2, optionBox.y + optionBox.height / 2, { steps: 8 });
  await expect(menu).toBeVisible();
});

test("host score controls fit a narrow desktop without scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await mockHost(page, { activeQuestion: { categoryIndex: 0, rowIndex: 0, answerRevealed: false } });
  await page.goto("/#/jeopardy");
  const scoreboard = page.locator("#scoreboard");
  await expect(scoreboard).toBeVisible();
  expect(await scoreboard.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.locator(".team").last()).toBeInViewport();
});

test("host standings fit all twelve teams across the screen", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  const hostTeams = Array.from({ length: 12 }, (_, index) => ({ name: `Team ${index + 1}`, score: index * 1_000 }));
  await mockHost(page, { hostTeams });
  await page.goto("/#/hub");
  const scoreboard = page.locator("#scoreboard");
  await expect(page.locator(".team")).toHaveCount(12);
  expect(await scoreboard.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.locator(".team").last()).toBeInViewport();
});
