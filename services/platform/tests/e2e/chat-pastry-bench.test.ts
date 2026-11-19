// Portal chat agent control of the Kitchen Pie Pastry Bench. The agent's
// `pastry_bench_configure` call reaches the owner's Pastry Bench page as a
// `configure_pastry_bench` page command. `chat-costs-commands` proves the
// shared page command path: the receipt, and the refusal without the page.
import { http, type HttpResponseResolver } from "msw";
import { expect, it, vi } from "vitest";
import {
  KITCHEN_SURFACE,
  PASTRY_BENCH_VIEW_COMMANDS,
  newConversationId,
  type SurfaceObservationV2,
} from "@seams/control-api";
import {
  createBakerySurfaceReceipt,
  parseBakerySurfaceEffect,
  type BakerySurfaceEffectV1,
} from "@seams/bakery-model/bakery-surface";
import { isRecord } from "@seams/std";

import {
  createConversation,
  installMemoryFixture,
  post,
  type Member,
} from "./memory-support";
import { network } from "./network";
import { openRouterText, openRouterToolCall } from "./slack-journey-support";
import { finished, lastToolCallName } from "./chat-journey-support";

const BROWSER = "browser-pastry-owner";
const SESSION_ID = "pastry-bench-session-1";

/** The Pastry Bench page as the owner's browser sends it now. */
function observation(pieType: string): SurfaceObservationV2 {
  return {
    kind: "surface-observation",
    schemaVersion: 2,
    surface: KITCHEN_SURFACE,
    area: "BakeryOS",
    instance: {
      browserInstanceId: BROWSER,
      surfaceSessionId: SESSION_ID,
      epoch: 0,
    },
    title: "Workflow simulator",
    path: "/portal/nuki/kitchen/workflow-simulator",
    record: null,
    capturedAt: Date.now(),
    view: [
      {
        title: "Pie pastry bench configuration",
        facts: [{ label: "Pie variety", value: pieType }],
        table: null,
      },
    ],
    state: null,
    commands: [...PASTRY_BENCH_VIEW_COMMANDS],
    sources: [],
  };
}

it(
  "sends the agent's Pastry Bench configuration to the owner's Pastry Bench page",
  { timeout: 240_000 },
  async (): Promise<void> => {
    const { author, route, paths } = await installMemoryFixture();
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        configureBench,
      ),
    );
    const conversationId = newConversationId();
    await createConversation(author, conversationId, route);

    const sent = await post(author, paths.chat, {
      kind: "message",
      conversationId,
      requestId: `request_${conversationId}_configure`,
      model: route.model,
      text: "Switch the pastry bench to beef bourguignon with a 3.5 mm shell, 52 N crimp, and the unfloured bench check.",
      browserContext: {
        kind: "available",
        binding: { browserInstanceId: BROWSER, conversationId },
      },
      surfaceObservation: observation("steak-and-pepper"),
    });
    expect(sent.status, await sent.clone().text()).toBe(200);

    const effect = await vi.waitFor(
      () => pageCommand(author, paths.chat, conversationId),
      { timeout: 30_000, interval: 500 },
    );
    expect(effect.command).toMatchObject({
      kind: "page_command",
      surface: KITCHEN_SURFACE,
      target: { surfaceSessionId: SESSION_ID, epoch: 0 },
      command: {
        name: "configure_pastry_bench",
        pieType: "beef-bourguignon",
        targetThicknessMm: 3.5,
        crimpForceN: 52,
        faultCheck: "unfloured-bench",
        cameraPreset: "dough-block",
      },
      binding: { browserInstanceId: BROWSER, conversationId },
    });

    // The page answers, so the turn ends.
    const receipt = await createBakerySurfaceReceipt(effect, {
      kind: "page_completed",
      observation: observation("beef-bourguignon"),
    });
    const settled = await post(
      author,
      `${paths.chat}/surface-effects/${effect.effectId}/receipt`,
      { receipt },
    );
    expect(settled.status, await settled.clone().text()).toBe(200);
    await finished(author, conversationId);
  },
);

/** The scripted model: it finds the configure tool, calls it, and answers. */
async function configureBench({
  request,
}: Parameters<HttpResponseResolver>[0]): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    throw new Error("Invalid model request");
  }
  const last: unknown = body.messages.at(-1);
  if (
    isRecord(last) &&
    last.role === "tool" &&
    lastToolCallName(body.messages) === "pastry_bench_configure"
  ) {
    return openRouterText(
      "Updated the Pastry Bench.",
      `pastry_reply_${crypto.randomUUID()}`,
    );
  }
  const offered =
    Array.isArray(body.tools) &&
    body.tools.some(
      (tool: unknown) =>
        isRecord(tool) &&
        isRecord(tool.function) &&
        tool.function.name === "pastry_bench_configure",
    );
  return offered
    ? openRouterToolCall(
        "pastry_bench_configure",
        {
          pieType: "beef-bourguignon",
          targetThicknessMm: 3.5,
          crimpForceN: 52,
          faultCheck: "unfloured-bench",
          cameraPreset: "dough-block",
        },
        `pastry_call_${crypto.randomUUID()}`,
      )
    : openRouterToolCall(
        "tool_search",
        { query: "pastry_bench_configure", limit: 2 },
        `pastry_discover_${crypto.randomUUID()}`,
      );
}

/** The page command that waits for the owner's browser. */
async function pageCommand(
  author: Member,
  chatPath: string,
  conversationId: string,
): Promise<BakerySurfaceEffectV1> {
  const response = await post(
    author,
    `${chatPath}/surface-effects?browserInstanceId=${BROWSER}&conversationId=${conversationId}`,
    null,
  );
  const body: unknown = await response.json();
  const effects =
    isRecord(body) && Array.isArray(body.effects) ? body.effects : [];
  for (const entry of effects) {
    if (!isRecord(entry)) continue;
    const parsed = parseBakerySurfaceEffect(entry.effect);
    if (parsed.kind === "valid" && parsed.value.command.kind === "page_command")
      return parsed.value;
  }
  throw new Error("No page command reached the browser");
}
