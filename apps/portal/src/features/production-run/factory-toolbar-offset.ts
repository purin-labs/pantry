/**
 * The Factory view's bars (canvas layout, appliance strip, summary, detail
 * drawer) float below its toolbar, and the toolbar wraps to more rows with
 * the workspace width and its title. This keeps --factory-toolbar-bottom on
 * the workspace at the toolbar's measured bottom, as the Workflow view
 * measures its own bars. It returns the function that stops the watch.
 */
export function watchFactoryToolbar(workspace: HTMLElement): () => void {
  const toolbar = workspace.querySelector<HTMLElement>(
    ":scope > header.factory-toolbar",
  );
  if (toolbar === null) return stopNothing;
  const place = placeBelow.bind(null, workspace, toolbar);
  const observer = new ResizeObserver(place);
  observer.observe(toolbar);
  place();
  return observer.disconnect.bind(observer);
}

function placeBelow(workspace: HTMLElement, toolbar: HTMLElement): void {
  workspace.style.setProperty(
    "--factory-toolbar-bottom",
    `${String(toolbar.offsetTop + toolbar.offsetHeight)}px`,
  );
}

function stopNothing(): void {}
