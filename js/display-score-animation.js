import { playPointSound } from "./display-sounds.js?v=10";

function reducedMotion() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function countScore(output, from, to, duration = 420) {
  if (!output || reducedMotion()) {
    if (output) output.textContent = to.toLocaleString("de-CH");
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const started = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - ((1 - progress) ** 3);
      output.textContent = Math.round(from + ((to - from) * eased)).toLocaleString("de-CH");
      if (progress < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

function centerOrigin() {
  return { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
}

async function animateAward(root, origin, award) {
  const card = root.querySelector(`.display-team[data-team-index="${award.teamIndex}"]`);
  const output = card?.querySelector(".display-team-score");
  if (!card || !output) return;
  const deducted = award.points < 0;
  const start = origin || centerOrigin();
  const destination = output.getBoundingClientRect();
  if (!reducedMotion()) {
    const badge = document.createElement("div");
    badge.className = `display-points-flight${deducted ? " deducted" : ""}`;
    badge.textContent = deducted
      ? `−${Math.abs(award.points).toLocaleString("de-CH")}`
      : `+${award.points.toLocaleString("de-CH")}`;
    badge.style.left = `${start.left + start.width / 2}px`;
    badge.style.top = `${start.top + start.height / 2}px`;
    document.body.append(badge);
    const dx = destination.left + destination.width / 2 - (start.left + start.width / 2);
    const dy = destination.top + destination.height / 2 - (start.top + start.height / 2);
    await badge.animate([
      { transform: "translate(-50%, -50%) scale(.65)", opacity: 0 },
      { transform: "translate(-50%, -50%) scale(1.16)", opacity: 1, offset: 0.28 },
      { transform: "translate(-50%, -50%) scale(1)", opacity: 1, offset: 0.52 },
      { transform: "translate(-50%, -50%) scale(1)", opacity: 1 }
    ], { duration: 700, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" }).finished.catch(() => undefined);
    await badge.animate([
      { transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
      { transform: `translate(calc(-50% + ${dx * 0.58}px), calc(-50% + ${dy * 0.42 - 55}px)) scale(1.08)`, opacity: 1, offset: 0.48 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.5)`, opacity: 0.2 }
    ], { duration: 320, easing: "cubic-bezier(.35,.05,.7,.2)", fill: "forwards" }).finished.catch(() => undefined);
    badge.remove();
  }
  playPointSound(award.points);
  const arrivalClass = deducted ? "points-deducted" : "points-arrived";
  card.classList.add(arrivalClass);
  await countScore(output, award.oldScore, award.newScore);
  setTimeout(() => card.classList.remove(arrivalClass), 550);
  await new Promise((resolve) => setTimeout(resolve, reducedMotion() ? 0 : 120));
}

export async function animateScoreDistribution({ root, awards, origins = [] }) {
  awards.forEach(({ teamIndex, oldScore }) => {
    const output = root.querySelector(`.display-team[data-team-index="${teamIndex}"] .display-team-score`);
    if (output) output.textContent = oldScore.toLocaleString("de-CH");
  });
  for (const award of awards) await animateAward(root, origins[award.teamIndex] || null, award);
}
