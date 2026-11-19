// Portal chat agent control of the Kitchen Pie Pastry Bench (MuJoCo 4.0.0
// deformable flexcomp shortcrust sheeting & puff-lid crimping). Proves:
// 1. An authorized owner configures and runs the Pastry Bench on their screen,
//    receiving the signed page_command receipt and updated deformable telemetry.
// 2. A message sent without the Pastry Bench on screen is refused with no
//    browser effect dispatched.
// 3. A viewer without owner/admin authority stays refused even when their
//    message carries a Pastry Bench observation.
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  KITCHEN_SURFACE,
  PASTRY_BENCH_VIEW_COMMANDS,
  newConversationId,
  type ConversationId,
  type SurfaceObservationV2,
} from "@seams/control-api";
import {
  createBakerySurfaceReceipt,
  parseBakerySurfaceEffect,
  type BakerySurfaceEffectV1,
} from "@seams/bakery-model/bakery-surface";
import { isRecord } from "@seams/std";
import { env } from "cloudflare:workers";

import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  createConversation,
  installMemoryFixture,
  post,
  workKind,
  type Member,
} from "./memory-support";
import { network } from "./network";
import { openRouterText, openRouterToolCall } from "./slack-journey-support";
import { lastToolCallName } from "./chat-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatPastryBench?: Record<string, unknown>;
  }
}

const OWNER_BROWSER = "browser-pastry-owner";
const VIEWER_BROWSER = "browser-pastry-viewer";
const SESSION_ID = "pastry-bench-session-1";

function pastryBenchObservation(
  browserInstanceId: string,
  config: Readonly<{
    pieType: string;
    thicknessMm: string;
    crimpForceN: string;
    faultCheck: string;
    cameraPreset?: string;
    shortcrustDrapeMm: string;
    puffLidDrapeMm: string;
    sealPct: string;
    ovenChamberC?: string;
    puffLiftMm?: string;
    browningPct?: string;
  }>,
): SurfaceObservationV2 {
  return {
    kind: "surface-observation",
    schemaVersion: 2,
    surface: KITCHEN_SURFACE,
    area: "BakeryOS",
    instance: {
      browserInstanceId,
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
        facts: [
          { label: "Pie variety", value: config.pieType },
          { label: "Shortcrust target thickness", value: config.thicknessMm },
          { label: "Rim crimp force", value: config.crimpForceN },
          { label: "Process check", value: config.faultCheck },
          {
            label: "Active camera view",
            value: config.cameraPreset ?? "bench",
          },
        ],
        table: null,
      },
      {
        title: "MuJoCo 4.0.0 flexcomp deformable shell telemetry",
        facts: [
          {
            label: "3D dough block slab",
            value:
              "22.16 mm height · 81.56 mm span (75 vertices · 128 boundary triangles)",
          },
          { label: "Shortcrust cavity drape", value: config.shortcrustDrapeMm },
          { label: "Puff-lid cavity drape", value: config.puffLidDrapeMm },
          { label: "Rim crimp seal coverage", value: config.sealPct },
          {
            label: "Deformable mesh",
            value: "81 vertices · 128 triangles",
          },
        ],
        table: null,
      },
      {
        title: "Maruzen MBCO-5E oven bake",
        facts: [
          {
            label: "Peak convection chamber",
            value: config.ovenChamberC ?? "200.0 °C",
          },
          {
            label: "Puff lamination lift",
            value: config.puffLiftMm ?? "+5.60 mm",
          },
          {
            label: "Maillard crust browning",
            value: config.browningPct ?? "94.0%",
          },
        ],
        table: null,
      },
    ],
    state: null,
    commands: [...PASTRY_BENCH_VIEW_COMMANDS],
    sources: [],
  };
}

type ScriptState = {
  mode: "configure" | "prepare" | "viewer";
  requests: string[];
  toolResults: string[];
};

it(
  "controls the Kitchen Pie Pastry Bench for an authorized owner and refuses a viewer or missing screen",
  { timeout: 240_000 },
  async ({ task }: TestContext): Promise<void> => {
    const { author, viewer, route, paths } = await installMemoryFixture();
    const script: ScriptState = {
      mode: "configure",
      requests: [],
      toolResults: [],
    };
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        scriptedPastryModel.bind(null, script),
      ),
    );

    const ownerConv = newConversationId();
    await createConversation(author, ownerConv, route);

    // 1. Owner configures Beef Bourguignon 3.5 mm / 52 N / unfloured-bench check.
    const configureRes = await send(
      author,
      paths.chat,
      ownerConv,
      route.model,
      OWNER_BROWSER,
      {
        label: "configure",
        text: "Switch the pastry bench to beef bourguignon with a 3.5 mm shell, 52 N crimp, and the unfloured bench check.",
        surfaceObservation: pastryBenchObservation(OWNER_BROWSER, {
          pieType: "steak-and-pepper",
          thicknessMm: "3.0 mm",
          crimpForceN: "42 N",
          faultCheck: "none",
          shortcrustDrapeMm: "22.44 mm",
          puffLidDrapeMm: "18.44 mm",
          sealPct: "100.0%",
        }),
      },
    );
    expect(configureRes.status, await configureRes.clone().text()).toBe(200);

    const effect = await pendingPageCommand(
      author,
      paths.chat,
      OWNER_BROWSER,
      ownerConv,
    );
    if (effect.command.kind !== "page_command") {
      throw new Error("Expected a page_command surface effect");
    }
    expect(effect.command).toMatchObject({
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
      binding: { browserInstanceId: OWNER_BROWSER, conversationId: ownerConv },
    });

    const receipt = await createBakerySurfaceReceipt(effect, {
      kind: "page_completed",
      observation: pastryBenchObservation(OWNER_BROWSER, {
        pieType: "beef-bourguignon",
        thicknessMm: "3.5 mm",
        crimpForceN: "52 N",
        faultCheck: "unfloured-bench",
        cameraPreset: "dough-block",
        shortcrustDrapeMm: "22.54 mm",
        puffLidDrapeMm: "18.66 mm",
        sealPct: "100.0%",
        ovenChamberC: "200.0 °C",
        puffLiftMm: "+5.60 mm",
        browningPct: "94.0%",
      }),
    });
    const settled = await post(
      author,
      `${paths.chat}/surface-effects/${effect.effectId}/receipt`,
      { receipt },
    );
    expect(settled.status, await settled.clone().text()).toBe(200);
    await finish(author, ownerConv);

    const ownerResult = script.toolResults.at(-1) ?? "";
    expect(ownerResult).toContain("page_completed");
    expect(ownerResult).toContain("beef-bourguignon");
    expect(ownerResult).toContain("22.54 mm");
    expect(ownerResult).toContain("75 vertices · 128 boundary triangles");
    expect(ownerResult).toContain("81 vertices · 128 triangles");
    expect(ownerResult).toContain("Maruzen MBCO-5E oven bake");
    expect(ownerResult).toContain("+5.60 mm");

    const timelineRes = await post(
      author,
      `${paths.chat}?conversation=${ownerConv}`,
      null,
    );
    const timelineJson = JSON.stringify(await timelineRes.json());
    expect(timelineJson).toContain("Configure pie pastry bench");
    expect(timelineJson).toContain("beef-bourguignon");
    expect(timelineJson).toContain("dough-block view");

    // 1B. Owner runs `pastry_bench_prepare` on the attached Pastry Bench screen.
    script.mode = "prepare";
    script.toolResults.length = 0;
    const prepareRes = await send(
      author,
      paths.chat,
      ownerConv,
      route.model,
      OWNER_BROWSER,
      {
        label: "prepare",
        text: "Now run the pastry bench simulation with these settings.",
        surfaceObservation: pastryBenchObservation(OWNER_BROWSER, {
          pieType: "beef-bourguignon",
          thicknessMm: "3.5 mm",
          crimpForceN: "52 N",
          faultCheck: "unfloured-bench",
          shortcrustDrapeMm: "22.54 mm",
          puffLidDrapeMm: "18.66 mm",
          sealPct: "100.0%",
        }),
      },
    );
    expect(prepareRes.status, await prepareRes.clone().text()).toBe(200);

    const prepareEffect = await pendingPageCommand(
      author,
      paths.chat,
      OWNER_BROWSER,
      ownerConv,
    );
    if (prepareEffect.command.kind !== "page_command") {
      throw new Error("Expected a page_command surface effect for prepare");
    }
    expect(prepareEffect.command).toMatchObject({
      surface: KITCHEN_SURFACE,
      target: { surfaceSessionId: SESSION_ID, epoch: 0 },
      command: { name: "prepare_pastry_bench" },
      binding: { browserInstanceId: OWNER_BROWSER, conversationId: ownerConv },
    });

    const prepareReceipt = await createBakerySurfaceReceipt(prepareEffect, {
      kind: "page_completed",
      observation: pastryBenchObservation(OWNER_BROWSER, {
        pieType: "beef-bourguignon",
        thicknessMm: "3.5 mm",
        crimpForceN: "52 N",
        faultCheck: "unfloured-bench",
        shortcrustDrapeMm: "22.54 mm",
        puffLidDrapeMm: "18.66 mm",
        sealPct: "100.0%",
      }),
    });
    const prepareSettled = await post(
      author,
      `${paths.chat}/surface-effects/${prepareEffect.effectId}/receipt`,
      { receipt: prepareReceipt },
    );
    expect(prepareSettled.status, await prepareSettled.clone().text()).toBe(200);
    await finish(author, ownerConv);
    const prepareResult = script.toolResults.at(-1) ?? "";
    expect(prepareResult).toContain("page_completed");
    expect(await pageCommandCount(author)).toBe(2);

    // 2. Follow-up message without the Pastry Bench on screen is refused.
    script.mode = "prepare";
    script.toolResults.length = 0;
    const noScreenRes = await send(
      author,
      paths.chat,
      ownerConv,
      route.model,
      OWNER_BROWSER,
      {
        label: "no-screen",
        text: "Re-run the pastry bench simulation again.",
      },
    );
    expect(noScreenRes.status, await noScreenRes.clone().text()).toBe(200);
    await finish(author, ownerConv);
    const noScreenRefusal = script.toolResults.at(-1) ?? "";
    expect(noScreenRefusal).toContain(
      "does not carry Kitchen Pastry Bench",
    );
    expect(await pageCommandCount(author)).toBe(2);

    // 3. Viewer without chat/surface role authority stays refused with zero effects.
    const viewerConv = newConversationId();
    const viewerRes = await send(
      viewer,
      paths.chat,
      viewerConv,
      route.model,
      VIEWER_BROWSER,
      {
        label: "viewer-attempt",
        text: "Configure the pastry bench to beef bourguignon.",
        surfaceObservation: pastryBenchObservation(VIEWER_BROWSER, {
          pieType: "steak-and-pepper",
          thicknessMm: "3.0 mm",
          crimpForceN: "42 N",
          faultCheck: "none",
          shortcrustDrapeMm: "22.44 mm",
          puffLidDrapeMm: "18.44 mm",
          sealPct: "100.0%",
        }),
      },
    );
    expect(viewerRes.status).toBe(404);
    const viewerBody = await viewerRes.text();
    expect(viewerBody).toContain("organisation_role_insufficient");
    expect(await pageCommandCount(author)).toBe(2);

    task.meta.chatPastryBench = {
      dispatchedConfigureCommand: effect.command,
      dispatchedPrepareCommand: prepareEffect.command,
      ownerToolResult: ownerResult,
      prepareToolResult: prepareResult,
      noScreenRefusal,
      viewerRefusal: viewerBody,
      totalPageCommandsDispatched: await pageCommandCount(author),
    };
  },
);

async function scriptedPastryModel(
  script: ScriptState,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    throw new Error("Invalid model request");
  }
  script.requests.push(JSON.stringify(body));
  const last: unknown = body.messages.at(-1);
  const lastCallName = lastToolCallName(body.messages);

  if (script.mode === "viewer") {
    if (isRecord(last) && last.role === "tool" && lastCallName === "tool_search") {
      script.toolResults.push(JSON.stringify(last.content));
      return openRouterText(
        "I do not have permission to control the Kitchen Pastry Bench.",
        `pastry_viewer_reply_${script.requests.length}`,
      );
    }
    return openRouterToolCall(
      "tool_search",
      { query: "pastry_bench_configure", limit: 3 },
      `pastry_viewer_search_${script.requests.length}`,
    );
  }

  const targetTool =
    script.mode === "configure"
      ? "pastry_bench_configure"
      : "pastry_bench_prepare";
  if (isRecord(last) && last.role === "tool" && lastCallName === targetTool) {
    script.toolResults.push(JSON.stringify(last.content));
    return openRouterText(
      "Updated the Kitchen Pie Pastry Bench.",
      `pastry_reply_${script.requests.length}`,
    );
  }
  const offered = Array.isArray(body.tools)
    ? body.tools.some(
        (tool: unknown) =>
          isRecord(tool) &&
          isRecord(tool.function) &&
          tool.function.name === targetTool,
      )
    : false;
  if (!offered) {
    return openRouterToolCall(
      "tool_search",
      { query: targetTool, limit: 2 },
      `pastry_discover_${script.requests.length}`,
    );
  }
  return script.mode === "configure"
    ? openRouterToolCall(
        "pastry_bench_configure",
        {
          pieType: "beef-bourguignon",
          targetThicknessMm: 3.5,
          crimpForceN: 52,
          faultCheck: "unfloured-bench",
          cameraPreset: "dough-block",
        },
        `pastry_call_${script.requests.length}`,
      )
    : openRouterToolCall(
        "pastry_bench_prepare",
        {},
        `pastry_call_${script.requests.length}`,
      );
}

function send(
  member: Member,
  chatPath: string,
  conversationId: ConversationId,
  model: string,
  browserInstanceId: string,
  message: Readonly<{
    label: string;
    text: string;
    surfaceObservation?: SurfaceObservationV2;
  }>,
): Promise<Response> {
  return post(member, chatPath, {
    kind: "message",
    conversationId,
    requestId: `request_${conversationId}_${message.label}`,
    model,
    text: message.text,
    browserContext: {
      kind: "available",
      binding: { browserInstanceId, conversationId },
    },
    ...(message.surfaceObservation === undefined
      ? {}
      : { surfaceObservation: message.surfaceObservation }),
  });
}

async function pendingPageCommand(
  member: Member,
  chatPath: string,
  browserInstanceId: string,
  conversationId: ConversationId,
): Promise<BakerySurfaceEffectV1> {
  let found: BakerySurfaceEffectV1 | null = null;
  await expect
    .poll(
      async () => {
        found = await readPageCommand(
          member,
          chatPath,
          browserInstanceId,
          conversationId,
        );
        return found !== null;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  if (found === null) throw new Error("No page command reached the browser");
  return found;
}

async function readPageCommand(
  member: Member,
  chatPath: string,
  browserInstanceId: string,
  conversationId: ConversationId,
): Promise<BakerySurfaceEffectV1 | null> {
  const response = await post(
    member,
    `${chatPath}/surface-effects?browserInstanceId=${browserInstanceId}&conversationId=${conversationId}`,
    null,
  );
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.effects)) return null;
  for (const entry of body.effects) {
    if (!isRecord(entry)) continue;
    const parsed = parseBakerySurfaceEffect(entry.effect);
    if (parsed.kind === "valid" && parsed.value.command.kind === "page_command")
      return parsed.value;
  }
  return null;
}

async function pageCommandCount(member: Member): Promise<number> {
  const scope = await requireOrganisationExecutionScope(
    env,
    member.organisationId,
  );
  const row = await scope.database
    .prepare(
      "SELECT COUNT(*) AS count FROM bakery_surface_effect_delivery WHERE organisation_id = ? AND json_extract(effect_json, '$.command.kind') = 'page_command'",
    )
    .bind(member.organisationId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function finish(
  member: Member,
  conversationId: ConversationId,
): Promise<void> {
  await expect
    .poll(workKind.bind(null, member, conversationId), { timeout: 60_000 })
    .toBe("ready");
}
