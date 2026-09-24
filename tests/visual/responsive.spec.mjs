import { test, expect } from "@playwright/test";
import { expectNoViewportOverflow, expectVisibleControlsUsable } from "./layout.js";
import {
  basePresentation, buzzer, config, listingActive, listingBase, listingResults, listingReview,
  orderingActive, orderingBase, orderingResults, selection, syncActive, syncLobby, syncResults,
  teamLobby, teamNames
} from "./fixtures.js";
import { displayPresentation, mockHost, mockLiveSocket, mockPlayer, playerSnapshot } from "./mock-app.js";

const desktopViewports = [{ width: 1280, height: 720 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }];

async function verify(page, name, { phone = false, screenshot = true, allowVerticalScroll = phone } = {}) {
  await expect(page.locator("body")).toBeVisible();
  await expectNoViewportOverflow(page, { allowVerticalScroll });
  await expectVisibleControlsUsable(page, phone ? 40 : 30, { allowOffscreen: allowVerticalScroll });
  if (screenshot) await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: phone });
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

test("Jeopardy buzzer distinguishes current team and waiting queue", async ({ page }) => {
  await mockHost(page, { activeQuestion: { categoryIndex: 0, rowIndex: 0, answerRevealed: false } });
  await page.goto("/#/jeopardy");
  await expect(page.locator("#buzzer-panel")).toHaveAttribute("data-state", "buzzed");
  await expect(page.locator("#buzzer-active-team")).toHaveText(teamNames[0]);
  await expect(page.locator("#buzz-order li")).toHaveCount(teamNames.length - 1);
  await expect(page.locator(".buzz-position").first()).toHaveText("2");
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
