export type AgentStarterTemplate = {
  readonly templateId: string;
  readonly name: string;
  readonly tagline: string;
  readonly agent: {
    readonly displayName: string;
    readonly role: string;
    readonly purpose: string;
    readonly instructions: string;
  };
  readonly requestedCapabilities: readonly string[];
  readonly skill: {
    readonly title: string;
    readonly markdownBody: string;
  } | null;
};

export const AGENT_STARTER_TEMPLATES: readonly AgentStarterTemplate[] = [
  {
    templateId: "restock",
    name: "Restock agent",
    tagline: "Watches inventory and prepares restock work for review.",
    agent: {
      displayName: "Restock agent",
      role: "Inventory assistant",
      purpose: "Keep shelf stock ahead of demand.",
      instructions: [
        "You watch stock levels for this workspace and prepare restock work.",
        "",
        "- Review low stock signals as they arrive.",
        "- Compare on-hand counts with recent sales before proposing anything.",
        "- Prepare a restock proposal for review; never assume a change is applied without approval.",
        "- Flag anything perishable or seasonal separately so the owner can decide quickly.",
      ].join("\n"),
    },
    requestedCapabilities: ["commerce.entity_plane.context"],
    skill: {
      title: "Restock checklist",
      markdownBody: [
        "1. Confirm the current on-hand count for the item.",
        "2. Check recent sales volume for the last two weeks.",
        "3. Propose order quantities that cover one week of expected sales.",
        "4. Use a shorter cover window for perishable items.",
        "5. Note any supplier constraints in the proposal.",
      ].join("\n"),
    },
  },
  {
    templateId: "catalog-publisher",
    name: "Catalog publisher",
    tagline: "Prepares product listings and requests publication.",
    agent: {
      displayName: "Catalog publisher",
      role: "Listing assistant",
      purpose: "Prepare product listings for publication.",
      instructions: [
        "You prepare product listings for this workspace and request publication.",
        "",
        "- Review draft listings for complete names, descriptions, and prices.",
        "- Request publication only for listings that pass the quality checklist.",
        "- Publication requests always wait for owner approval.",
      ].join("\n"),
    },
    requestedCapabilities: [
      "commerce.entity_plane.context",
      "commerce.action.propose",
    ],
    skill: {
      title: "Listing quality checklist",
      markdownBody: [
        "1. The product name is specific and free of internal codes.",
        "2. The description states what the customer receives.",
        "3. The price is present and matches the current price list.",
        "4. Allergens and dietary notes are included for food items.",
      ].join("\n"),
    },
  },
];

export function starterTemplateById(
  templateId: string | null,
): AgentStarterTemplate | null {
  if (templateId === null) return null;
  return (
    AGENT_STARTER_TEMPLATES.find(
      (template) => template.templateId === templateId,
    ) ?? null
  );
}
