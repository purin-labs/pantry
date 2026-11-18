// Chat content is the existing preview. Preferences use the real local Worker.
const plan53NativeFetch = window.fetch.bind(window);
let plan53PreviewFetch = plan53NativeFetch;
window.plan53PreferenceRequests = [];
window.plan53FailSaves = false;
window.plan53FailBakeryReads = new URL(location.href).searchParams.has(
  "failBakeryPreferences",
);
window.plan53ConflictBudget = 0;
window.plan53ReleaseReads = false;
window.plan53HoldWrites = false;
window.plan53WritePending = false;
window.plan53ActiveChatWrites = 0;
window.plan53PeakChatWrites = 0;
Object.defineProperty(window, "fetch", {
  configurable: true,
  get: plan53FetchGetter,
  set: plan53FetchSetter,
});
function plan53FetchGetter() {
  return plan53Fetch;
}
function plan53FetchSetter(value) {
  plan53PreviewFetch = value;
}
async function plan53Fetch(input, init) {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    location.origin,
  );
  if (!url.pathname.startsWith("/v1/control/user/preferences/")) {
    return url.pathname.includes("organisation_chat_preview")
      ? plan53PreviewFetch(input, init)
      : plan53NativeFetch(input, init);
  }
  const method = init?.method ?? "GET";
  if (
    (method === "PATCH" && window.plan53FailSaves) ||
    (method === "GET" &&
      url.pathname.endsWith("/bakeryos") &&
      window.plan53FailBakeryReads)
  ) {
    window.plan53PreferenceRequests.push({
      area: url.pathname.split("/").at(-1),
      method,
      status: 503,
    });
    return Response.json(
      { error: "acceptance_network_failure" },
      { status: 503 },
    );
  }
  if (method === "PATCH" && window.plan53ConflictBudget > 0) {
    window.plan53ConflictBudget--;
    const current = await (
      await plan53NativeFetch(`http://127.0.0.1:8833${url.pathname}`, {
        credentials: "include",
      })
    ).json();
    await plan53NativeFetch(`http://127.0.0.1:8833${url.pathname}`, {
      ...init,
      credentials: "include",
      body: JSON.stringify({
        expectedUserId: current.userId,
        expectedRevision: current.revision,
        command: {
          kind: "set_fullscreen_chat_sidebar_width",
          widthPx: 441 + window.plan53ConflictBudget,
        },
      }),
    });
  }
  const trackChatWrite = method === "PATCH" && url.pathname.endsWith("/chat");
  if (trackChatWrite) {
    window.plan53ActiveChatWrites++;
    window.plan53PeakChatWrites = Math.max(
      window.plan53PeakChatWrites,
      window.plan53ActiveChatWrites,
    );
  }
  try {
    const response = await plan53NativeFetch(
      `http://127.0.0.1:8833${url.pathname}`,
      { ...init, credentials: "include" },
    );
    if (method === "PATCH" && window.plan53HoldWrites) {
      window.plan53WritePending = true;
      while (window.plan53HoldWrites) await new Promise(plan53Delay);
      window.plan53WritePending = false;
    }
    if (
      method === "GET" &&
      url.pathname.endsWith("/chat") &&
      new URL(location.href).searchParams.has("delayPreferences")
    ) {
      while (!window.plan53ReleaseReads) await new Promise(plan53Delay);
    }
    window.plan53PreferenceRequests.push({
      area: url.pathname.split("/").at(-1),
      method,
      status: response.status,
    });
    return response;
  } finally {
    if (trackChatWrite) window.plan53ActiveChatWrites--;
  }
}

function plan53Delay(resolve) {
  setTimeout(resolve, 50);
}
