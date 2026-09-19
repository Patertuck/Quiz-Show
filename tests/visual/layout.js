import { expect } from "@playwright/test";

export async function expectNoViewportOverflow(page, { allowVerticalScroll = false } = {}) {
  const result = await page.evaluate(({ allowVerticalScroll }) => {
    const root = document.documentElement;
    const body = document.body;
    const width = Math.max(root.scrollWidth, body.scrollWidth);
    const height = Math.max(root.scrollHeight, body.scrollHeight);
    return {
      horizontal: width - window.innerWidth,
      vertical: allowVerticalScroll ? 0 : height - window.innerHeight,
      viewport: [window.innerWidth, window.innerHeight],
      document: [width, height],
      overflowers: [...document.querySelectorAll("body *")].flatMap((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1 ? [{
          tag: element.tagName, id: element.id, className: element.className,
          width: rect.width, left: rect.left, right: rect.right
        }] : [];
      }).slice(0, 12)
    };
  }, { allowVerticalScroll });
  expect(result.horizontal, JSON.stringify(result)).toBeLessThanOrEqual(1);
  expect(result.vertical, JSON.stringify(result)).toBeLessThanOrEqual(1);
}

export async function expectVisibleControlsUsable(page, minimum = 32, { allowOffscreen = false } = {}) {
  const failures = await page.evaluate(({ minimum, allowOffscreen }) => [...document.querySelectorAll("button, a, input, select")]
    .filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width && rect.height;
    })
    .flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const center = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const scrollableAncestor = [...function* ancestors(node) {
        for (let parent = node.parentElement; parent; parent = parent.parentElement) yield parent;
      }(element)].some((parent) => {
        const style = getComputedStyle(parent);
        return [style.overflow, style.overflowX, style.overflowY].some((value) => ["auto", "scroll"].includes(value));
      });
      const covered = !scrollableAncestor && center && center !== element && !element.contains(center) && !center.contains(element);
      const outside = !allowOffscreen && (rect.right < 0 || rect.bottom < 0 || rect.left > innerWidth || rect.top > innerHeight);
      const tooSmall = element.matches("button, a") && (rect.width < minimum || rect.height < minimum);
      return covered || outside || tooSmall ? [{
        tag: element.tagName, id: element.id, className: element.className,
        text: element.textContent?.trim().slice(0, 50), covered, outside, tooSmall,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }] : [];
    }), { minimum, allowOffscreen });
  expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
}
