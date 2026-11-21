// The Portal chat agent reads and changes recipes and suppliers as staff do on
// the pages (Plan 81). A real shop on the production Worker and Commerce; only
// the model answers from a script. A missing read and capability each raise the
// Allow prompt, a change from a private chat asks once for each change, a stale
// edit and a wrong unit are refused, and the person's own pages show the result.
import { env, exports } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  parseRecipeCollection,
  type RecipeCollection,
} from "@purin-labs/kitchen-control-api";
import { isRecord } from "@purin-labs/std";
import {
  parseListEntryReadRequest,
  CommerceEntityPlaneClient,
} from "@purin-labs/commerce-client";

import { accessControlPath } from "./access-route-support";
import {
  ask,
  lastCalledTool,
  pausedRequest,
  resumeChat,
} from "./chat-permission-support";
import { commerceHeaders, connectCommerceFixture } from "./commerce-support";
import {
  installMemoryFixture,
  postJson,
  type MemoryFixture,
} from "./memory-support";
import { raiseLabel } from "./held-exit-support";
import { network } from "./network";
import { allowAsPortal } from "./permission-request-support";
import { providerClient } from "./pi-sdk-effect-support";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
} from "./slack-journey-support";
import {
  agentReceipts,
  chatDirect,
  finished,
  messageWord,
  startChat,
} from "./chat-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatAgentRecipesSuppliers?: Record<string, unknown>;
  }
}

const MERCHANT_ID = "merchant_chat_recipes";
/** The sentence of the exit check: the step stopped, and a person was asked. */
const STOPPED = "Seams Pantry stopped this step";

/** What the model does for one chat message, found by a word in the message. */
type Script = Readonly<{
  tool: string;
  args: () => Record<string, unknown>;
  /** What the agent asks for when the tool is not in its catalogue. */
  ask?: Readonly<{ capabilityIds: readonly string[] }>;
  /** The turn reads a text of a person outside the Organisation first. */
  outsideText?: true;
}>;

type RecipeArgs = Readonly<{
  recipeId: string | null;
  expectedRecipeRevision: number | null;
  name: string;
  inputs: readonly unknown[];
  output: Record<string, unknown>;
}>;

type Journey = {
  readonly outputs: Record<string, string[]>;
  modelRequests: number;
  /** The change that the agent makes, from the recipe that the person sees. */
  edit: RecipeArgs | null;
  stale: RecipeArgs | null;
  added: RecipeArgs | null;
  wrongUnit: RecipeArgs | null;
  afterOutsideText: RecipeArgs | null;
  /** Adds the read of an outside person's text to the turn that runs. */
  readOutsideText: () => Promise<void>;
  itemId: string;
};

function supplier(
  displayName: string,
  itemId: string,
): Record<string, unknown> {
  return {
    displayName,
    legalName: `${displayName} KK`,
    countryCode: "JP",
    contactName: "Sato",
    email: "orders@kyoto-mill.example.test",
    phone: null,
    leadTimeDays: 4,
    minimumOrderQuantity: "2.5",
    minimumOrderUnit: "bag",
    purchasingNotes: null,
    inventoryItemIds: [itemId],
  };
}

function scripts(journey: Journey): Readonly<Record<string, Script>> {
  const save = (args: () => RecipeArgs | null): (() => RecipeArgs) => {
    return () => {
      const value = args();
      if (value === null) throw new Error("The script has no recipe");
      return value;
    };
  };
  const create = (): Script => ({
    tool: "supplier_create",
    args: () => supplier("Kyoto Mill", journey.itemId),
    ask: { capabilityIds: ["commerce.supplier.create"] },
  });
  return {
    READRECIPES: { tool: "recipe_read", args: () => ({}) },
    SAVERECIPE: {
      tool: "recipe_save",
      args: save(() => journey.edit),
      ask: { capabilityIds: ["commerce.recipe.save"] },
    },
    STALERECIPE: { tool: "recipe_save", args: save(() => journey.stale) },
    WRONGUNIT: { tool: "recipe_save", args: save(() => journey.wrongUnit) },
    ADDRECIPE: { tool: "recipe_save", args: save(() => journey.added) },
    NOPURCHASING: create(),
    READSUPPLIERS: { tool: "supplier_read", args: () => ({}) },
    ADDSUPPLIER: create(),
    SUPPLIERAGAIN: create(),
    // The later message's prompt also holds the first message of its chat,
    // so its word comes first here.
    LATERRECIPE: {
      tool: "recipe_save",
      args: save(() => journey.afterOutsideText),
    },
    OUTSIDETEXT: { tool: "recipe_read", args: () => ({}), outsideText: true },
  };
}

it(
  "lets the Portal chat agent change recipes and suppliers with the person's checks, prompts and receipts, and refuses a stale edit",
  { timeout: 480_000 },
  async ({ task }: TestContext): Promise<void> => {
    const fixture = await installMemoryFixture();
    const { author, paths } = fixture;
    await connectCommerceFixture(
      author.organisationId,
      author.userId,
      MERCHANT_ID,
    );
    const demo = await providerClient().provisionDemo({
      schemaVersion: "commerce.provision-demo.v2",
      externalReference: author.organisationId,
      merchantId: MERCHANT_ID,
      profile: "cafe_patisserie",
      createdAt: new Date().toISOString(),
    });
    if (!demo.ok) throw new Error(JSON.stringify(demo.error));
    const journey: Journey = {
      outputs: {},
      modelRequests: 0,
      edit: null,
      stale: null,
      added: null,
      wrongUnit: null,
      afterOutsideText: null,
      readOutsideText: () =>
        raiseLabel(
          {
            owner: {
              kind: "organisation",
              organisationId: author.organisationId,
            },
            readers: [{ kind: "person", personId: author.personId }],
          },
          "outside",
          author.organisationId,
        ),
      itemId: "",
    };
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        replyToModel.bind(null, journey),
      ),
    );
    const evidence: Record<string, unknown> = {};

    /** The person's own Recipes page read. It proves the outcome. */
    const library = async (): Promise<RecipeCollection> => {
      const read = await postJson(
        author,
        `${paths.organisation}/commerce/recipes`,
        null,
      );
      expect(read.status).toBe(200);
      return parseRecipeCollection(read.body);
    };
    const lastOutput = (word: string): string => {
      const output = journey.outputs[word]?.at(-1);
      if (output === undefined) throw new Error(`No output for ${word}`);
      return output;
    };

    await chatThrough(fixture, "GETREADY", {});

    // 1. A refused recipe read asks in the chat. The agent then reads what the
    //    page shows, and no text sends the owner to a settings page.
    const recipeRead = await chatThrough(fixture, "READRECIPES", {
      action: "Read recipes",
    });
    evidence.recipeReadAction = recipeRead.action;
    const before = await library();
    const source = before.recipes.find(
      (recipe) => recipe.output.kind === "stocked" && recipe.inputs.length > 0,
    );
    if (source === undefined || source.output.kind !== "stocked")
      throw new Error("The shop has no stocked recipe");
    const read = lastOutput("READRECIPES");
    expect(read).toContain(source.recipeId);
    expect(read).toContain(source.name);
    const firstInput = source.inputs[0];
    if (firstInput === undefined) throw new Error("No ingredient");
    const item = before.items.find(
      (candidate) => candidate.id === firstInput.inventoryItemId,
    );
    if (item === undefined) throw new Error("No ingredient item");
    expect(read).toContain(item.name);
    journey.itemId = item.id;

    // 2. The agent has no way to save. It asks once, and the owner allows it.
    //    A change from a private chat then asks once more: every member reads
    //    the recipe. Nothing moves until the owner allows that.
    const doubled = {
      ...firstInput,
      quantity: {
        ...firstInput.quantity,
        amount: firstInput.quantity.amount * 2,
      },
    };
    const output = {
      kind: "stocked",
      inventoryItemId: source.output.inventoryItemId,
      yieldQuantity: source.output.yieldQuantity,
    };
    journey.edit = {
      recipeId: source.recipeId,
      expectedRecipeRevision: source.revision,
      name: `${source.name} (double)`,
      inputs: [doubled, ...source.inputs.slice(1)],
      output,
    };
    await chatThrough(fixture, "SAVERECIPE", {
      action: "Create and edit recipes",
    });
    expect(lastOutput("SAVERECIPE")).toContain(STOPPED);
    expect(
      (await library()).recipes.find(
        (recipe) => recipe.recipeId === source.recipeId,
      )?.revision,
    ).toBe(source.revision);
    await allowHeldStep(fixture);
    await chatDirect(fixture, fixture.author, "SAVERECIPE");
    expect(lastOutput("SAVERECIPE")).toContain("receiptId");
    const edited = (await library()).recipes.find(
      (recipe) => recipe.recipeId === source.recipeId,
    );
    expect(edited).toMatchObject({
      revision: source.revision + 1,
      name: `${source.name} (double)`,
    });
    expect(edited?.inputs[0]?.quantity.amount).toBe(
      firstInput.quantity.amount * 2,
    );

    // 3. Another edit names the revision that the agent read first. It is
    //    refused in words, and the recipe stays as the first save left it.
    journey.stale = { ...journey.edit, name: `${source.name} (stale)` };
    await chatApproved(fixture, "STALERECIPE");
    expect(lastOutput("STALERECIPE")).toContain("changed after you read it");
    const afterStale = await library();
    expect(
      afterStale.recipes.find((recipe) => recipe.recipeId === source.recipeId)
        ?.revision,
    ).toBe(source.revision + 1);
    expect(
      afterStale.recipes.find((recipe) => recipe.recipeId === source.recipeId)
        ?.name,
    ).toBe(`${source.name} (double)`);

    // 4. A quantity in another unit than the item's is refused by the shop, as
    //    on the page. A sale may move the shop's revision: that costs a repeat.
    journey.wrongUnit = {
      ...journey.edit,
      expectedRecipeRevision: source.revision + 1,
      inputs: [
        {
          ...firstInput,
          quantity: {
            ...firstInput.quantity,
            unit: firstInput.quantity.unit === "each" ? "gram" : "each",
          },
        },
      ],
    };
    await chatApproved(fixture, "WRONGUNIT");
    expect(lastOutput("WRONGUNIT")).toContain("resource_relationship_invalid");
    expect(
      (await library()).recipes.find(
        (recipe) => recipe.recipeId === source.recipeId,
      )?.revision,
    ).toBe(source.revision + 1);

    // 5. A new recipe takes its id from the call.
    journey.added = {
      recipeId: null,
      expectedRecipeRevision: null,
      name: "Agent madeleines",
      inputs: [firstInput],
      output: { kind: "immediate", inventoryItemId: null, yieldQuantity: null },
    };
    await chatApproved(fixture, "ADDRECIPE");
    expect(lastOutput("ADDRECIPE")).toContain("receiptId");
    const added = (await library()).recipes.find(
      (recipe) => recipe.name === "Agent madeleines",
    );
    expect(added).toMatchObject({ revision: 1, output: { kind: "immediate" } });

    // Each save has one receipt of the person's route, and a refusal has none.
    evidence.recipeReceipts = await agentReceipts(
      fixture,
      `${paths.organisation}/commerce/recipes`,
    );
    expect(evidence.recipeReceipts).toEqual([
      { operation: "recipe.create", n: 1 },
      { operation: "recipe.edit", n: 1 },
    ]);

    // 6. Suppliers: one Allow gives the capability and the read that it needs.
    //    With purchasing off, the shop has no directory, and the words say who
    //    can turn it on.
    const supplierAsk = await chatThrough(fixture, "NOPURCHASING", {
      action: "Read suppliers and add suppliers",
    });
    evidence.supplierAskAction = supplierAsk.action;
    expect(lastOutput("NOPURCHASING")).toContain(STOPPED);
    await allowHeldStep(fixture);
    await chatDirect(fixture, fixture.author, "NOPURCHASING");
    expect(lastOutput("NOPURCHASING")).toContain("Activate purchasing");

    // 7. A person turns purchasing on and adds a supplier on the page. The agent
    //    reads it, with its contact.
    await personPosts(fixture, "commerce/purchasing/activate", {});
    await personPosts(fixture, "commerce/suppliers", {
      supplierId: "acceptance-mill",
      displayName: "Acceptance Mill",
      legalName: "Acceptance Mill KK",
      countryCode: "JP",
      contactName: "Ito",
      email: "mill@example.test",
      phone: null,
      leadTimeDays: 3,
      minimumOrderQuantity: "1",
      minimumOrderUnit: "bag",
      purchasingNotes: null,
      inventoryItemIds: [item.id],
    });
    await chatDirect(fixture, fixture.author, "READSUPPLIERS");
    const suppliers = lastOutput("READSUPPLIERS");
    expect(suppliers).toContain("acceptance-mill");
    expect(suppliers).toContain("Acceptance Mill");
    expect(suppliers).toContain("mill@example.test");

    // 8. The agent adds a supplier. The directory holds it, as the page reads
    //    it, with one receipt of the person's route.
    await chatApproved(fixture, "ADDSUPPLIER");
    expect(lastOutput("ADDSUPPLIER")).toContain("kyoto-mill");
    const entry = await directoryEntry("supplier:kyoto-mill");
    expect(
      entry.attributeValues.find(
        (attribute) => attribute.attributeId === "email",
      )?.value,
    ).toMatchObject({ value: "orders@kyoto-mill.example.test" });
    evidence.supplierReceipts = await agentReceipts(
      fixture,
      `${paths.organisation}/commerce/suppliers`,
    );
    expect(evidence.supplierReceipts).toEqual([
      { operation: "commerce.supplier.create", n: 1 },
    ]);

    // 9. The same name again is refused, and the agent sees why.
    await chatApproved(fixture, "SUPPLIERAGAIN");
    expect(lastOutput("SUPPLIERAGAIN")).toContain("may exist");
    expect(
      await agentReceipts(fixture, `${paths.organisation}/commerce/suppliers`),
    ).toEqual([{ operation: "commerce.supplier.create", n: 1 }]);

    // 10. A chat reads a text of a person outside the Organisation. A later
    //     message of that chat saves a recipe. The private chat asks, as in
    //     step 2, and the outside text asks too, with the recipe's values. The
    //     recipe exists only after both. A chat with no such text needed one
    //     Allow in step 5.
    journey.afterOutsideText = { ...journey.added, name: "After outside text" };
    const marked = await startChat(fixture, fixture.author, "OUTSIDETEXT");
    await finished(author, marked);
    const later = async (attempt: string): Promise<string> => {
      const before = journey.outputs.LATERRECIPE?.length ?? 0;
      await ask(
        author,
        paths.chat,
        marked,
        fixture.route.model,
        "LATERRECIPE now.",
        `LATERRECIPE_${attempt}`,
      );
      // The chat was ready before this message, so wait for the step itself.
      await expect
        .poll(() => journey.outputs.LATERRECIPE?.length ?? 0, {
          timeout: 60_000,
        })
        .toBe(before + 1);
      await finished(author, marked);
      return lastOutput("LATERRECIPE");
    };
    const stops = [await later("first")];
    await allowHeldStep(fixture);
    stops.push(await later("second"));
    expect(stops[0]).toContain(STOPPED);
    expect(stops[1]).toContain(STOPPED);
    expect(
      stops.filter((text) => text.includes("outside the Organisation")),
    ).toHaveLength(1);
    expect(
      (await library()).recipes.some(
        (recipe) => recipe.name === "After outside text",
      ),
    ).toBe(false);
    await allowHeldStep(fixture);
    expect(await later("third")).toContain("receiptId");
    expect(
      (await library()).recipes.some(
        (recipe) => recipe.name === "After outside text",
      ),
    ).toBe(true);

    for (const outputs of Object.values(journey.outputs))
      for (const text of outputs) expect(text).not.toContain("access controls");

    task.meta.chatAgentRecipesSuppliers = {
      ...evidence,
      recipe: {
        id: source.recipeId,
        revisionBefore: source.revision,
        revisionAfter: edited?.revision,
      },
      staleRefusal: lastOutput("STALERECIPE"),
      wrongUnitRefusal: lastOutput("WRONGUNIT"),
      duplicateSupplierRefusal: lastOutput("SUPPLIERAGAIN"),
      purchasingOffRefusal: lastOutput("NOPURCHASING"),
      modelRequests: journey.modelRequests,
    };
  },
);

/** A person's own click on a page, with the page's key. */
async function personPosts(
  fixture: MemoryFixture,
  path: string,
  body: unknown,
): Promise<void> {
  const headers = commerceHeaders(fixture.author.session);
  headers.set("idempotency-key", crypto.randomUUID());
  const response = await exports.default.fetch(
    `https://localhost${fixture.paths.organisation}/${path}`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

async function directoryEntry(entryId: string) {
  const plane = new CommerceEntityPlaneClient({
    baseUrl: "http://commerce.test",
    serviceToken: "commerce-e2e-token",
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  });
  const read = await plane.readListEntry(
    parseListEntryReadRequest({
      merchantId: MERCHANT_ID,
      listId: "supplier_directory",
      entryId,
    }),
  );
  if (!read.ok || read.value.kind === "missing")
    throw new Error(`No entry ${entryId}`);
  return read.value.entry;
}

/** The owner allows the one step that the exit check holds. */
async function allowHeldStep(fixture: MemoryFixture): Promise<void> {
  const base = accessControlPath(fixture.organisationId);
  const headers = commerceHeaders(fixture.author.session);
  const list = await exports.default.fetch(`${base}/permission-requests`, {
    headers,
  });
  expect(list.status).toBe(200);
  const body: unknown = await list.json();
  if (!isRecord(body) || !Array.isArray(body.heldOutputs))
    throw new Error("Pending list invalid");
  const held: unknown = body.heldOutputs.at(-1);
  if (!isRecord(held) || typeof held.requestId !== "string")
    throw new Error("No held step");
  const decided = await exports.default.fetch(
    `${base}/held-outputs/${held.requestId}/decision`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "allow" }),
    },
  );
  expect(decided.status, await decided.clone().text()).toBe(200);
}

/** One chat message that the exit check stops, and the same again once allowed. */
async function chatApproved(
  fixture: MemoryFixture,
  word: string,
): Promise<void> {
  await chatDirect(fixture, fixture.author, word);
  await allowHeldStep(fixture);
  await chatDirect(fixture, fixture.author, word);
}

/** One chat message that pauses on a request, which the owner allows in place. */
async function chatThrough(
  fixture: MemoryFixture,
  word: string,
  options: Readonly<{ action?: string }>,
): Promise<Readonly<{ action: unknown }>> {
  const person = fixture.author;
  const conversationId = await startChat(fixture, fixture.author, word);
  const pause = await pausedRequest(person, fixture.paths.chat, conversationId);
  if (options.action !== undefined)
    expect(pause.permission).toMatchObject({ action: options.action });
  const allowed = await allowAsPortal(
    person.organisationId,
    person.session,
    pause.id,
  );
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  const resumed = await resumeChat(
    person,
    fixture.paths.chat,
    conversationId,
    pause.id,
  );
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  await finished(person, conversationId);
  return { action: pause.permission.action };
}

async function replyToModel(
  journey: Journey,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  journey.modelRequests += 1;
  const id = `recipes_${String(journey.modelRequests)}`;
  const reply = (text: string): Response =>
    openRouterText(JSON.stringify({ kind: "reply", text }), id);
  const called = lastCalledTool(body);
  const all = scripts(journey);
  const word = messageWord(body, ["GETREADY", ...Object.keys(all)]);
  if (word === "GETREADY")
    return called === null
      ? openRouterToolCall(
          "request_permission",
          {
            capabilityIds: ["commerce.entity_plane.context"],
            entityTypeReads: [],
          },
          `call_${id}`,
        )
      : reply("Ready.");
  const script = all[word];
  if (script === undefined) throw new Error(`No script for ${word}`);
  const callTool = async (): Promise<Response> => {
    if (script.outsideText === true) await journey.readOutsideText();
    return openRouterToolCall(script.tool, script.args(), `call_${id}`);
  };
  if (called === null)
    return offeredToolNames(body).includes(script.tool)
      ? callTool()
      : openRouterToolCall(
          "tool_search",
          { query: script.tool, limit: 1 },
          `call_${id}`,
        );
  const output = requireLastToolOutput(body);
  switch (called) {
    case "tool_search":
      if (offeredToolNames(body).includes(script.tool)) return callTool();
      if (script.ask === undefined)
        throw new Error(`${word} found no ${script.tool}: ${output}`);
      return openRouterToolCall(
        "request_permission",
        { capabilityIds: script.ask.capabilityIds, entityTypeReads: [] },
        `call_${id}`,
      );
    case "request_permission":
      expect(output).toContain("Allow prompt");
      return reply("I asked for permission.");
    case script.tool: {
      if (output.includes("Allow prompt")) {
        expect(output).not.toContain("access controls");
        return reply("I asked for permission.");
      }
      journey.outputs[word] = [...(journey.outputs[word] ?? []), output];
      return reply(`Finished ${word}.`);
    }
    default:
      throw new Error(`Unexpected tool ${called} for ${word}`);
  }
}
