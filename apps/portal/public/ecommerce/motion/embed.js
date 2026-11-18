const studies = new Set([
  "demand-terrain",
  "packing-slow",
  "oven-rack",
]);
const study = new URLSearchParams(location.search).get("study");
const motion = document.querySelector("#motion");
const preference = matchMedia("(prefers-reduced-motion: reduce)");
let paused = preference.matches;

function applyMotion(handle, intensity) {
  HL.setReducedMotion(paused);
  handle.set(intensity);
  motion.textContent = paused ? "Resume motion" : "Pause motion";
}

function toggleMotion(handle, intensity) {
  paused = !paused;
  applyMotion(handle, intensity);
}

function updatePreference(handle, intensity, event) {
  paused = event.matches;
  applyMotion(handle, intensity);
}

function showError() {
  document.querySelector("#error").hidden = false;
}

function hairline(figure) {
  const stage = document.querySelector("#stage");
  const read = document.querySelector("#read");
  HL.inject(document);
  stage.dataset.hairline = figure.name;
  stage.setAttribute("role", "img");
  stage.setAttribute("aria-label", figure.means);
  const svg = HL.mk(
    "svg",
    { viewBox: "0 0 400 320", "aria-hidden": "true" },
    stage,
  );
  HL.setReducedMotion(paused);
  const handle = figure.mount({ stage, svg, read }, figure.range[1]);
  applyMotion(handle, figure.range[1]);
  motion.hidden = study !== "packing-slow";
  motion.addEventListener(
    "click",
    toggleMotion.bind(null, handle, figure.range[1]),
  );
  preference.addEventListener(
    "change",
    updatePreference.bind(null, handle, figure.range[1]),
  );
  addEventListener("pagehide", handle.destroy, { once: true });
}

if (studies.has(study)) {
  const script = document.createElement("script");
  script.src = `./${study}.js`;
  script.addEventListener("error", showError);
  document.head.append(script);
} else {
  showError();
}
