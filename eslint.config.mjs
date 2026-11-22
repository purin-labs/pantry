import parser from "@typescript-eslint/parser";
import stylistic from "@stylistic/eslint-plugin";

import { PLATFORM_SOURCE, PORTAL_SOURCE } from "./scripts/lib/source-roots.mjs";

const definitions = [
  "function",
  "class",
  "type",
  "interface",
  "enum",
  "export",
];

const nativeAudienceFactoryImport = {
  group: ["**/native-audience", "**/native-audience.*"],
  importNames: ["createNativeChatAudience"],
  message:
    "Use resolveNativeChatAudience; only its owner validates live native membership.",
  allowTypeImports: true,
};
const internalAdmissionImport = {
  group: [
    "**/assembly/internal",
    "**/assembly/internal.*",
    "**/assembly/internal/index*",
  ],
  message:
    "Use prepareTurnContext or assembleTurnContext; its owner creates the live admission permit.",
  allowTypeImports: true,
};
const rawProjectionImport = {
  group: [
    "**/context/projection",
    "**/context/projection/index",
    "**/context/projection/index.*",
  ],
  importNames: ["createContextProjectionReader"],
  message:
    "Use the protected read/turn-context boundary before reading source projections.",
  allowTypeImports: true,
};
const protectedMaterializerImport = {
  group: [
    "**/assembly",
    "**/assembly/index",
    "**/assembly/index.*",
    "**/model-context-prompt",
    "**/model-context-prompt.*",
  ],
  importNames: ["materializeContextBundle", "modelContextPrompt"],
  message:
    "Source-derived model context comes from admitted bundles and Actor observation evidence.",
  allowTypeImports: true,
};
const disclosureProofImport = {
  group: ["**/disclosure-evidence", "**/disclosure-evidence.*"],
  importNames: ["createDisclosureProof"],
  message:
    "Use checkConversationDisclosure; proofs follow live history and recipient checks.",
  allowTypeImports: true,
};
const rawMemoryStoreImport = {
  group: ["**/memory/store", "**/memory/store.*"],
  importNames: [
    "applyMemoryCommand",
    "listMemories",
    "prepareMemoryCommand",
    "readAcceptedMemories",
    "readMemory",
    "readMemoryCommandReceipt",
    "restoreAcceptedMemory",
    "restoreSerializedMemory",
  ],
  message:
    "Read and change Memory through the OrganisationActor commands and the authorized Memory reader.",
  allowTypeImports: true,
};
const localMemoryStoreImport = {
  ...rawMemoryStoreImport,
  group: ["./store", "./store.*"],
};
const rawEvalStoreImport = {
  group: ["**/evals/store", "**/evals/store.*"],
  importNames: [
    "applyEvalCommand",
    "listEvals",
    "prepareEvalCommand",
    "readEval",
    "readEvalCommandReceipt",
    "restoreSerializedEval",
    "listEvalRunResults",
    "restoreSerializedEvalRunResult",
    "settleEvalRunResult",
  ],
  message:
    "Read and change Evals through the OrganisationActor commands and the authorized Eval reader.",
  allowTypeImports: true,
};
const localEvalStoreImport = {
  ...rawEvalStoreImport,
  group: ["./store", "./store.*"],
};
const rawExecutionRecordsImport = {
  group: [
    "**/actors/case-execution-records",
    "**/actors/agent-session-execution-records",
    "**/actors/organisation-execution-records",
    "./case-execution-records",
    "./agent-session-execution-records",
    "./organisation-execution-records",
  ],
  importNames: [
    "readCaseExecutionRecords",
    "readCaseExecutionContent",
    "readSessionExecutionRecords",
    "readSessionExecutionContent",
    "readCaseEffectRecords",
  ],
  message:
    "Read a Case's execution through case-execution/access.ts. It decides what each reader may see.",
  allowTypeImports: true,
};
const ifcBoundaryOwners = [
  "foundation/conversation/chat/information-flow.ts",
  "foundation/agent/context/turn-context.ts",
  "foundation/agent/context/assembly/internal.ts",
  "foundation/agent/context/assembly/index.ts",
  "foundation/agent/context/files/tools.ts",
  "foundation/conversation/projects/context.ts",
  "foundation/conversation/chat/input-admission.ts",
  "foundation/conversation/chat/conversation-disclosure.ts",
  "foundation/agent/actors/actor-journal.ts",
  "foundation/agent/actors/actor-journal/**/*.ts",
  "services/platform/src/actors/agent-session.ts",
  "foundation/tool-handlers/actors/session/**/*.ts",
  "foundation/agent/actors/session/**/*.ts",
];
const localContextProjectionImport = {
  group: [
    "./projection",
    "../projection",
    "./projection/index",
    "../projection/index",
  ],
  importNames: ["createContextProjectionReader"],
  message: "Read projections through the authorized context boundary.",
  allowTypeImports: true,
};

/**
 * The Workers runtime and a browser both throw "Illegal invocation" when the
 * global fetch is called as a property of another object. The global may be
 * called, and it may not be passed, stored, bound or returned.
 */
const fetchValueMessage =
  'Do not use the global fetch as a value: a call through another object throws "Illegal invocation". Pass runtimeFetch from foundation/kernel/runtime-fetch.ts.';
const fetchValueSelectors = [
  'Property > Identifier.value[name="fetch"]',
  'CallExpression > Identifier.arguments[name="fetch"]',
  'NewExpression > Identifier.arguments[name="fetch"]',
  'MemberExpression > Identifier.object[name="fetch"]',
  'VariableDeclarator > Identifier.init[name="fetch"]',
  'AssignmentExpression > Identifier.right[name="fetch"]',
  'AssignmentPattern > Identifier.right[name="fetch"]',
  'LogicalExpression > Identifier[name="fetch"]',
  'ConditionalExpression > Identifier[name="fetch"]',
  'ReturnStatement > Identifier[name="fetch"]',
  'ArrowFunctionExpression > Identifier.body[name="fetch"]',
  'ArrayExpression > Identifier[name="fetch"]',
  'TSAsExpression > Identifier[name="fetch"]',
  'TSSatisfiesExpression > Identifier[name="fetch"]',
];

// The source of the Platform Worker and of the Portal.
const workerAndPortalSource = [
  ...PLATFORM_SOURCE.map((folder) => `${folder}/**/*.ts`),
  ...PORTAL_SOURCE.map((folder) => `${folder}/**/*.{ts,tsx}`),
];

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/generated/**",
      "**/wasm-pkg/**",
      "**/.wrangler/**",
      "**/.vitepress/cache/**",
      "target/**",
    ],
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    languageOptions: {
      parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "@stylistic": stylistic },
    rules: {
      curly: ["error", "all"],
      "one-var": ["error", "never"],
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: definitions },
        { blankLine: "always", prev: definitions, next: "*" },
        { blankLine: "any", prev: "function-overload", next: "function" },
        {
          blankLine: "any",
          prev: "function-overload",
          next: "function-overload",
        },
      ],
    },
  },
  {
    files: workerAndPortalSource,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...fetchValueSelectors.map((selector) => ({
          selector,
          message: fetchValueMessage,
        })),
      ],
    },
  },
  {
    files: [
      "areas/integrations/server/provider-workflows/**/*.ts",
      "foundation/agent/provider-workflows/**/*.ts",
    ],
    rules: {
      "no-unused-vars": [
        "error",
        {
          args: "none",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: workerAndPortalSource,
    ignores: ifcBoundaryOwners,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            nativeAudienceFactoryImport,
            internalAdmissionImport,
            rawProjectionImport,
            protectedMaterializerImport,
            disclosureProofImport,
            rawMemoryStoreImport,
            rawEvalStoreImport,
            rawExecutionRecordsImport,
          ],
        },
      ],
    },
  },
  {
    files: ["foundation/agent/context/turn-context.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            nativeAudienceFactoryImport,
            disclosureProofImport,
            rawMemoryStoreImport,
            rawEvalStoreImport,
            rawExecutionRecordsImport,
          ],
        },
      ],
    },
  },
  {
    files: [
      "foundation/agent/context/**/*.ts",
      "foundation/agent-tools/context/**/*.ts",
    ],
    ignores: ifcBoundaryOwners,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            nativeAudienceFactoryImport,
            internalAdmissionImport,
            rawProjectionImport,
            localContextProjectionImport,
            protectedMaterializerImport,
            disclosureProofImport,
            rawMemoryStoreImport,
            rawEvalStoreImport,
            rawExecutionRecordsImport,
          ],
        },
      ],
    },
  },
  {
    files: ["foundation/agent/context/files/tools.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            nativeAudienceFactoryImport,
            internalAdmissionImport,
            protectedMaterializerImport,
            disclosureProofImport,
            rawMemoryStoreImport,
            rawEvalStoreImport,
            rawExecutionRecordsImport,
          ],
        },
      ],
    },
  },
  {
    files: [
      "foundation/agent/context/assembly/internal.ts",
      "foundation/agent/context/assembly/index.ts",
      "foundation/conversation/projects/context.ts",
      "foundation/conversation/chat/input-admission.ts",
      "foundation/agent/actors/actor-journal.ts",
      "foundation/agent/actors/actor-journal/**/*.ts",
      "services/platform/src/actors/agent-session.ts",
      "foundation/tool-handlers/actors/session/**/*.ts",
      "foundation/agent/actors/session/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            nativeAudienceFactoryImport,
            internalAdmissionImport,
            rawProjectionImport,
            disclosureProofImport,
            rawMemoryStoreImport,
            rawEvalStoreImport,
            rawExecutionRecordsImport,
          ],
        },
      ],
    },
  },
  {
    files: ["foundation/conversation/chat/conversation-disclosure.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            nativeAudienceFactoryImport,
            internalAdmissionImport,
            rawProjectionImport,
            protectedMaterializerImport,
            rawMemoryStoreImport,
            rawEvalStoreImport,
            rawExecutionRecordsImport,
          ],
        },
      ],
    },
  },
  {
    files: ["areas/brain/server/memory/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            nativeAudienceFactoryImport,
            internalAdmissionImport,
            rawProjectionImport,
            protectedMaterializerImport,
            disclosureProofImport,
            rawMemoryStoreImport,
            rawEvalStoreImport,
            rawExecutionRecordsImport,
            localMemoryStoreImport,
          ],
        },
      ],
    },
  },
  {
    files: ["areas/brain/server/evals/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            nativeAudienceFactoryImport,
            internalAdmissionImport,
            rawProjectionImport,
            protectedMaterializerImport,
            disclosureProofImport,
            rawMemoryStoreImport,
            rawEvalStoreImport,
            rawExecutionRecordsImport,
            localEvalStoreImport,
          ],
        },
      ],
    },
  },
  {
    // The OrganisationActor owns the Memory and Eval tables, and each
    // authorized reader verifies what it returns. Every other file reaches
    // them through those.
    files: [
      "services/platform/src/actors/organisation.ts",
      "services/platform/src/actors/organisation/organisation-*.ts",
      "foundation/tenancy/actors/organisation/organisation-record.ts",
      "foundation/agent/actors/organisation/organisation-policy.ts",
      "areas/commerce/server/actors/organisation/organisation-commerce.ts",
      "areas/brain/server/memory/access.ts",
      "areas/brain/server/evals/access.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            nativeAudienceFactoryImport,
            internalAdmissionImport,
            rawProjectionImport,
            protectedMaterializerImport,
            disclosureProofImport,
          ],
        },
      ],
    },
  },
  {
    // Each Actor reads its own execution records for the execution
    // projection. Every other file reaches them through that projection.
    files: ["services/platform/src/actors/case.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            nativeAudienceFactoryImport,
            internalAdmissionImport,
            rawProjectionImport,
            protectedMaterializerImport,
            disclosureProofImport,
            rawMemoryStoreImport,
            rawEvalStoreImport,
          ],
        },
      ],
    },
  },
  {
    files: [
      "services/platform/src/actors/agent-session.ts",
      "foundation/tool-handlers/actors/session/**/*.ts",
      "foundation/agent/actors/session/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            nativeAudienceFactoryImport,
            internalAdmissionImport,
            rawProjectionImport,
            disclosureProofImport,
            rawMemoryStoreImport,
            rawEvalStoreImport,
          ],
        },
      ],
    },
  },
  {
    files: ["foundation/conversation/chat/information-flow.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            internalAdmissionImport,
            rawProjectionImport,
            protectedMaterializerImport,
            disclosureProofImport,
            rawMemoryStoreImport,
            rawEvalStoreImport,
            rawExecutionRecordsImport,
          ],
        },
      ],
    },
  },
];
