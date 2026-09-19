export function element(tag, className, text, documentApi = document) {
  const node = documentApi.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function retryingLogo(className, source, retryDelay = 2000) {
  const logo = element("img", className);
  let retryTimer;
  logo.addEventListener("load", () => clearTimeout(retryTimer));
  logo.addEventListener("error", () => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (!logo.isConnected) return;
      const separator = source.includes("?") ? "&" : "?";
      logo.src = `${source}${separator}retry=${Date.now()}`;
    }, retryDelay);
  });
  logo.src = source;
  logo.alt = "";
  logo.setAttribute("aria-hidden", "true");
  return logo;
}
