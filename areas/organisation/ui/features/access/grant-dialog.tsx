import { Select } from "@purin-labs/ui/select";
import React from "react";
import type {
  CommerceEntityTypeId,
  SystemCommerceEntityKind,
} from "@purin-labs/commerce-contracts";
import type { StrictUnion } from "@purin-labs/type-utils";
import { parseEntityTypeId, SYSTEM_KINDS } from "@purin-labs/commerce-client";
import {
  CustomOperationPicker,
  type CustomConnectorAccessHandoff,
  type CustomOperationSelection,
} from "./custom-operation-picker";
import { CircleAlert } from "lucide-react";
import "./grant-form.css";
import { Link } from "react-router";

import {
  cancelDialog,
  DialogHeading,
  findOption,
  optionItem,
  renderOption,
  syncDialog,
} from "./dialog-elements";
import {
  FileResourcePicker,
  type FileResourcePickerTransport,
} from "./file-resource-picker";
import type {
  AccessControlCapabilityView,
  AccessControlGrantView,
  AccessControlOption,
  FileResourceAccount,
  FileResourceSelection,
} from "@purin-labs/control-api/portal/access-models";
import {
  categoryLabel,
  connectIntegrationHref,
  providerDependencyLabel,
} from "./presentation";

export type GrantDraft = StrictUnion<
  | Readonly<{
      kind: "custom_connector_operation";
      subject: AccessControlOption;
      capability: AccessControlCapabilityView;
      selection: CustomOperationSelection;
    }>
  | Readonly<{
      kind: "commerce_entity_type";
      subject: AccessControlOption;
      capability: AccessControlCapabilityView;
      entityTypeId: CommerceEntityTypeId;
    }>
  | Readonly<{
      kind: "platform";
      subject: AccessControlOption;
      capability: AccessControlCapabilityView;
    }>
  | Readonly<{
      kind: "provider_resource";
      subject: AccessControlOption;
      capability: AccessControlCapabilityView;
      integration: AccessControlOption;
      resource: AccessControlOption;
    }>
  | Readonly<{
      kind: "file_resource";
      subject: AccessControlOption;
      capability: AccessControlCapabilityView;
      selection: FileResourceSelection;
    }>
  | Readonly<{
      kind: "existing_target";
      subject: AccessControlOption;
      capability: AccessControlCapabilityView;
      resource: AccessControlOption;
    }>
  | Readonly<{
      kind: "published_commerce_target";
      subject: AccessControlOption;
      capability: AccessControlCapabilityView;
      resource: AccessControlOption;
    }>
>;

type GrantFormProps = Readonly<{
  organisationId: string;
  initialCustomConnector: CustomConnectorAccessHandoff | null;
  /** The form starts again each time this turns true. */
  active: boolean;
  busy: boolean;
  problem: string | null;
  initialFileProvider: FileResourceAccount["provider"] | null;
  initialSubjectRef: string;
  /**
   * The connected account of the system that the form shares. The form then
   * asks for no account, and it chooses the account's only resource.
   */
  fixedIntegration: AccessControlOption | null;
  capabilities: readonly AccessControlCapabilityView[];
  subjects: readonly AccessControlOption[];
  integrations: readonly AccessControlOption[];
  integrationProviders: ReadonlyMap<string, string>;
  integrationsPath: string | null;
  resources: readonly AccessControlOption[];
  fileAccounts: readonly FileResourceAccount[];
  filePicker: FileResourcePickerTransport;
  /** Cancel closes a dialog. A form inside a drawer has none. */
  cancel: (() => void) | null;
  /**
   * Loads the options of the chosen action. With an integration, an action on
   * a provider resource lists that account's resources.
   */
  chooseCapability: (
    capability: AccessControlCapabilityView | null,
    integration: AccessControlOption | null,
  ) => void;
  chooseIntegration: (integration: AccessControlOption | null) => void;
  submit: (draft: GrantDraft) => void;
  /**
   * A system's drawer offers two levels beside its single actions: every
   * read action, or every read and prepare action, in one press. An action
   * that changes data stays one grant at a time. `held` are the system's
   * active grants, so a level leaves out what the person already has.
   */
  levels: Readonly<{
    held: readonly AccessControlGrantView[];
    submit: (drafts: readonly GrantDraft[]) => void;
  }> | null;
}>;

/**
 * The page-level grant: a dialog that can share any system. A system's own
 * drawer shows the same form in place, with the system's account fixed.
 */
export function GrantAccessDialog(
  props: Omit<
    GrantFormProps,
    "active" | "cancel" | "fixedIntegration" | "levels"
  > &
    Readonly<{ open: boolean; close: () => void }>,
): React.ReactNode {
  const dialog = React.useRef<HTMLDialogElement>(null);
  React.useEffect(syncDialog.bind(null, dialog, props.open), [props.open]);
  const fileFlow = props.initialFileProvider !== null;
  return (
    <dialog
      className="access35-dialog"
      ref={dialog}
      aria-labelledby="access35-grant-dialog-title"
      onCancel={cancelDialog.bind(null, props.close)}
    >
      <div className="access35-grant-dialog">
        <DialogHeading
          id="access35-grant-dialog-title"
          title={fileFlow ? "Choose files for Purin Pantry" : "Grant access"}
          close={props.close}
        />
        <p>
          {fileFlow
            ? "Choose files or folders, then where Pantry can use them. Access is read-only."
            : "Choose who gets access and what they can do."}
        </p>
        <GrantForm
          {...props}
          active={props.open}
          cancel={props.close}
          fixedIntegration={null}
          levels={null}
        />
      </div>
    </dialog>
  );
}

export function GrantForm(props: GrantFormProps): React.ReactNode {
  const [subjectRef, setSubjectRef] = React.useState(props.initialSubjectRef);
  const [capabilityId, setCapabilityId] = React.useState(
    initialCapabilityId(props.initialCustomConnector, props.initialFileProvider),
  );
  const [integrationRef, setIntegrationRef] = React.useState("");
  const [resourceRef, setResourceRef] = React.useState("");
  const [customEntityType, setCustomEntityType] = React.useState("");
  const [fileSelection, setFileSelection] =
    React.useState<FileResourceSelection | null>(null);
  const [customSelection, setCustomSelection] =
    React.useState<CustomOperationSelection | null>(null);
  const [formProblem, setFormProblem] = React.useState("");
  React.useEffect(
    syncGrantDefaults.bind(
      null,
      props.active,
      props.initialFileProvider,
      props.initialSubjectRef,
      props.initialCustomConnector,
      setCustomSelection,
      setSubjectRef,
      setCapabilityId,
      setIntegrationRef,
      setResourceRef,
      setFileSelection,
      setFormProblem,
    ),
    [
      props.active,
      props.initialFileProvider,
      props.initialSubjectRef,
      props.initialCustomConnector,
    ],
  );
  const fileFlow = props.initialFileProvider !== null;
  const capability = findCapability(props.capabilities, capabilityId);
  const subject = findOption(props.subjects, subjectRef);
  const needsResource =
    capability !== null &&
    capability.definition.target !== "platform" &&
    capability.definition.target !== "file_resource" &&
    capability.definition.target !== "custom_connector_operation";
  const needsPublishedCommerceTarget =
    capability !== null &&
    (isPublishedCommerceListEntryPatch(capability) ||
      (isCommerceActionPropose(capability) &&
        props.resources.some(isCommerceTargetOption)));
  const needsAccount =
    capability?.definition.target === "provider_resource" &&
    !needsPublishedCommerceTarget;
  const needsFile = capability?.definition.target === "file_resource";
  const needsEntityType = capability?.definition.target === "commerce_read";
  const accounts =
    props.fixedIntegration === null
      ? compatibleIntegrations(
          props.integrations,
          props.integrationProviders,
          capability,
        )
      : [props.fixedIntegration];
  const accountMissing = needsAccount && accounts.length === 0;
  const resources = props.resources.filter(
    matchesCapabilityResource.bind(null, capabilityId),
  );
  // One resource that fits is the choice: the form does not ask for it.
  const onlyResource =
    resources.length === 1 && resources[0]?.availability === "available"
      ? resources[0]
      : null;
  const chosenResourceRef =
    resourceRef !== "" ? resourceRef : (onlyResource?.refId ?? "");
  const chosenIntegrationRef = props.fixedIntegration?.refId ?? integrationRef;
  const level = parseLevel(capabilityId);
  const levelPlan =
    level === null || props.levels === null
      ? null
      : planLevel(
          level,
          props.capabilities,
          props.levels.held,
          subject,
          props.fixedIntegration,
          props.resources,
          resourceRef,
        );
  return (
    <form
      className="access35-grant-form"
      onSubmit={
        levelPlan === null
          ? submitGrant.bind(
              null,
              props,
              subjectRef,
              capabilityId,
              chosenIntegrationRef,
              chosenResourceRef,
              customEntityType,
              fileSelection,
              customSelection,
              setFormProblem,
            )
          : submitLevel.bind(null, props.levels, levelPlan.drafts)
      }
    >
      <div className="access35-dialog-steps">
        {fileFlow ? (
          <>
            <div>
              <span>Files or folders</span>
              <FileResourcePicker
                accounts={props.fileAccounts}
                selection={fileSelection}
                change={setFileSelection}
                transport={props.filePicker}
              />
            </div>
            <div>
              <label htmlFor="access35-grant-subject">Available in</label>
              <Select.Root
                required
                items={props.subjects.map(optionItem)}
                value={subjectRef === "" ? null : subjectRef}
                onValueChange={(value) => setSubjectRef(value ?? "")}
              >
                <Select.Trigger id="access35-grant-subject">
                  <Select.Value placeholder="Choose where Pantry can use these files" />
                </Select.Trigger>
                <Select.Popup>{props.subjects.map(renderOption)}</Select.Popup>
              </Select.Root>
            </div>
            <p className="access35-grant-note">
              Pantry can read the selected files in{" "}
              {subject?.label ?? "the conversation or workflow you choose"}.
              Remove the access at any time.
            </p>
          </>
        ) : (
          <>
            <div>
              <label htmlFor="access35-grant-subject">Who</label>
              <Select.Root
                required
                items={props.subjects.map(optionItem)}
                value={subjectRef === "" ? null : subjectRef}
                onValueChange={(value) => setSubjectRef(value ?? "")}
              >
                <Select.Trigger id="access35-grant-subject">
                  <Select.Value placeholder="Select a person, channel, or agent" />
                </Select.Trigger>
                <Select.Popup>{props.subjects.map(renderOption)}</Select.Popup>
              </Select.Root>
            </div>
            <div>
              <label htmlFor="access35-grant-capability">What they can do</label>
              <Select.Root
                required
                items={[
                  ...(props.levels === null ? [] : LEVELS.map(levelItem)),
                  ...props.capabilities.map(capabilityItem),
                ]}
                value={capabilityId === "" ? null : capabilityId}
                onValueChange={changeCapability.bind(
                  null,
                  setCapabilityId,
                  setIntegrationRef,
                  setResourceRef,
                  props.capabilities,
                  props.fixedIntegration,
                  props.chooseCapability,
                  props.chooseIntegration,
                  setFileSelection,
                  setFormProblem,
                )}
              >
                <Select.Trigger id="access35-grant-capability">
                  <Select.Value placeholder="Select a level or an action" />
                </Select.Trigger>
                <Select.Popup>
                  {props.levels === null ? null : (
                    <Select.Group>
                      <Select.GroupLabel>Levels</Select.GroupLabel>
                      {LEVELS.map(
                        renderLevelOption.bind(
                          null,
                          props.capabilities,
                          props.fixedIntegration,
                        ),
                      )}
                    </Select.Group>
                  )}
                  {groupCapabilityOptions(props.capabilities).map(
                    renderCapabilityGroup,
                  )}
                </Select.Popup>
              </Select.Root>
              {capability?.definition.risk === "external_effect" ? (
                <p className="access35-inline-alert">
                  <CircleAlert aria-hidden="true" size={18} />
                  {capability.definition.target === "custom_connector_operation"
                    ? "Allows real changes through the selected API operation. Every write requires approval."
                    : `Allows real changes at ${providerDependencyLabel(capability.definition.providerDependency)}. Capability policy can require an approval for each use.`}
                </p>
              ) : null}
            </div>
            {level !== null && levelPlan !== null ? (
              renderLevelFields(
                level,
                levelPlan,
                subject,
                resourceRef,
                setResourceRef,
              )
            ) : props.active &&
              capability?.definition.target === "custom_connector_operation" &&
            (capabilityId === "custom_connector.read" ||
              capabilityId === "custom_connector.write") ? (
              <div>
                <CustomOperationPicker
                  key={capabilityId}
                  organisationId={props.organisationId}
                  capabilityId={capabilityId}
                  initial={props.initialCustomConnector}
                  selection={customSelection}
                  change={setCustomSelection}
                />
              </div>
            ) : accountMissing ? (
              <p className="access35-inline-alert" role="status">
                <CircleAlert aria-hidden="true" size={18} />
                {capability === null
                  ? "No connected account is available for this capability."
                  : `No ${providerDependencyLabel(capability.definition.providerDependency)} account is connected yet.`}
                {props.integrationsPath === null || capability === null ? null : (
                  <Link
                    to={connectIntegrationHref(
                      props.integrationsPath,
                      capability.definition.providerDependency,
                    )}
                  >
                    Connect it in Integrations
                  </Link>
                )}
              </p>
            ) : needsAccount ? (
              <>
                {props.fixedIntegration === null ? (
                  <div>
                    <label htmlFor="access35-grant-account">
                      Connected account
                    </label>
                    <Select.Root
                      required
                      items={accounts.map(optionItem)}
                      value={integrationRef === "" ? null : integrationRef}
                      onValueChange={changeIntegration.bind(
                        null,
                        accounts,
                        setIntegrationRef,
                        setResourceRef,
                        props.chooseIntegration,
                      )}
                    >
                      <Select.Trigger id="access35-grant-account">
                        <Select.Value placeholder="Select an account" />
                      </Select.Trigger>
                      <Select.Popup>{accounts.map(renderOption)}</Select.Popup>
                    </Select.Root>
                  </div>
                ) : null}
                {renderResourceField(
                  "Resource",
                  "Select a resource",
                  resources,
                  onlyResource,
                  resourceRef,
                  setResourceRef,
                )}
              </>
            ) : needsFile ? (
              <div>
                <span>File or folder</span>
                <FileResourcePicker
                  accounts={props.fileAccounts}
                  selection={fileSelection}
                  change={setFileSelection}
                  transport={props.filePicker}
                />
              </div>
            ) : needsEntityType ? (
              <div>
                <label htmlFor="access35-grant-resource">Commerce scope</label>
                <Select.Root
                  required
                  items={[...COMMERCE_SCOPE_ITEMS, ...resources.map(optionItem)]}
                  value={resourceRef === "" ? null : resourceRef}
                  onValueChange={(value) => setResourceRef(value ?? "")}
                >
                  <Select.Trigger id="access35-grant-resource">
                    <Select.Value placeholder="Select a commerce scope" />
                  </Select.Trigger>
                  <Select.Popup>
                    <Select.Item value="custom_entity_type">
                      Custom record type
                    </Select.Item>
                    <Select.Group>
                      <Select.GroupLabel>Record types</Select.GroupLabel>
                      {SYSTEM_KINDS.map(renderEntityTypeOption)}
                    </Select.Group>
                    {resources.length === 0 ? null : (
                      <Select.Group>
                        <Select.GroupLabel>Existing exact scopes</Select.GroupLabel>
                        {resources.map(renderOption)}
                      </Select.Group>
                    )}
                  </Select.Popup>
                </Select.Root>
                {resourceRef === "custom_entity_type" && (
                  <label>
                    Custom record type ID
                    <input
                      value={customEntityType}
                      onChange={changeCustomEntityType.bind(
                        null,
                        setCustomEntityType,
                      )}
                      required
                      placeholder="bakery_procedure"
                    />
                  </label>
                )}
                <p>
                  Read access covers records of this type in the current
                  connected shop.
                </p>
              </div>
            ) : needsResource ? (
              <>
                {renderResourceField(
                  needsPublishedCommerceTarget
                    ? "Published commerce list entry"
                    : "Existing exact scope",
                  needsPublishedCommerceTarget
                    ? "Select a published list entry"
                    : "Select an existing scope",
                  resources,
                  onlyResource,
                  resourceRef,
                  setResourceRef,
                )}
                {props.resources.length === 0 ? (
                  <p className="access35-inline-alert" role="status">
                    <CircleAlert aria-hidden="true" size={18} />
                    {needsPublishedCommerceTarget
                      ? "No published commerce list entry is available for this capability."
                      : "No current scope is available for this capability."}
                  </p>
                ) : null}
              </>
            ) : capability === null ? null : (
              <p className="access35-grant-note">
                {capability.definition.description}
              </p>
            )}
          </>
        )}
      </div>
      <p
        className="access35-inline-alert"
        role={formProblem.length === 0 ? undefined : "alert"}
      >
        {formProblem}
      </p>
      {props.problem === null ? null : (
        <p className="access35-inline-alert" role="alert">
          {props.problem}
        </p>
      )}
      <div className="access35-dialog-actions">
        {props.cancel === null ? null : (
          <button type="button" className="secondary" onClick={props.cancel}>
            Cancel
          </button>
        )}
        <button
          type="submit"
          className="connection-primary-action"
          disabled={
            props.busy ||
            accountMissing ||
            (levelPlan !== null && levelPlan.drafts.length === 0) ||
            ((fileFlow || capability?.definition.target === "file_resource") &&
              fileSelection === null) ||
            (capability?.definition.target === "custom_connector_operation" &&
              (customSelection === null ||
                customSelection.capabilityId !== capabilityId))
          }
        >
          {props.busy
            ? fileFlow
              ? "Adding files…"
              : "Granting access…"
            : fileFlow
              ? "Add files to Pantry"
              : "Grant access"}
        </button>
      </div>
    </form>
  );
}

type GrantLevel = "view" | "prepare";

const LEVELS: readonly GrantLevel[] = ["view", "prepare"];

const LEVEL_PREFIX = "level:";

type LevelPlan = Readonly<{
  /** The grants that one press makes for the chosen person. */
  drafts: readonly GrantDraft[];
  /** The actions of the level, when no person is chosen yet. */
  candidates: readonly AccessControlCapabilityView[];
  /** The resources that the level's actions share. */
  shared: readonly AccessControlOption[];
  /** An action of the level has more than one resource to choose from. */
  asksResource: boolean;
  /** The person's actions of the level that wait for a resource. */
  unresolved: number;
}>;

function parseLevel(value: string): GrantLevel | null {
  if (!value.startsWith(LEVEL_PREFIX)) return null;
  const level = value.slice(LEVEL_PREFIX.length);
  return level === "view" || level === "prepare" ? level : null;
}

/**
 * The actions of a level: those that read (and, for `prepare`, those that
 * prepare a change) and need no choice beyond one resource of the drawer's
 * account. An action that is off for the workspace is left out.
 */
function inLevel(
  level: GrantLevel,
  fixedIntegration: AccessControlOption | null,
  capability: AccessControlCapabilityView,
): boolean {
  const definition = capability.definition;
  if (capability.availability !== "available" || capability.mode === "disabled")
    return false;
  if (
    definition.risk !== "read" &&
    !(level === "prepare" && definition.risk === "propose")
  )
    return false;
  return (
    definition.target === "platform" ||
    (definition.target === "provider_resource" && fixedIntegration !== null)
  );
}

function planLevel(
  level: GrantLevel,
  capabilities: readonly AccessControlCapabilityView[],
  held: readonly AccessControlGrantView[],
  subject: AccessControlOption | null,
  fixedIntegration: AccessControlOption | null,
  resources: readonly AccessControlOption[],
  resourceRef: string,
): LevelPlan {
  const candidates = capabilities.filter(
    inLevel.bind(null, level, fixedIntegration),
  );
  const shared = resources.filter(isResourceFor.bind(null, ""));
  const sharedRef =
    resourceRef !== ""
      ? resourceRef
      : shared.length === 1
        ? (shared[0]?.refId ?? "")
        : "";
  const drafts: GrantDraft[] = [];
  let asksResource = false;
  let unresolved = 0;
  for (const capability of candidates) {
    if (
      subject !== null &&
      held.some(holdsCapability.bind(null, subject.refId, capability))
    )
      continue;
    if (capability.definition.target === "platform") {
      if (subject !== null) drafts.push({ kind: "platform", subject, capability });
      continue;
    }
    const own = resources.filter(
      isResourceFor.bind(null, capability.definition.capabilityId),
    );
    if (own.length > 1) asksResource = true;
    const resource =
      own.length === 1 ? own[0] : own.find(hasRefId.bind(null, sharedRef));
    if (subject === null || fixedIntegration === null) continue;
    if (resource === undefined) unresolved += 1;
    else
      drafts.push({
        kind: "provider_resource",
        subject,
        capability,
        integration: fixedIntegration,
        resource,
      });
  }
  return { drafts, candidates, shared, asksResource, unresolved };
}

function isResourceFor(
  capabilityId: string,
  option: AccessControlOption,
): boolean {
  return (
    option.availability === "available" &&
    matchesCapabilityResource(capabilityId, option)
  );
}

function hasRefId(refId: string, option: AccessControlOption): boolean {
  return option.refId === refId;
}

function holdsCapability(
  subjectRefId: string,
  capability: AccessControlCapabilityView,
  grant: AccessControlGrantView,
): boolean {
  return (
    grant.lifecycle.kind === "active" &&
    grant.subject.subjectRefId === subjectRefId &&
    grant.capability.capabilityId === capability.definition.capabilityId &&
    grant.capability.capabilityVersion ===
      capability.definition.capabilityVersion
  );
}

function levelLabel(level: GrantLevel): string {
  return level === "view"
    ? "Can view: every read action"
    : "Can prepare changes: every read and prepare action";
}

function levelItem(level: GrantLevel): Readonly<{ value: string; label: string }> {
  return { value: `${LEVEL_PREFIX}${level}`, label: levelLabel(level) };
}

function renderLevelOption(
  capabilities: readonly AccessControlCapabilityView[],
  fixedIntegration: AccessControlOption | null,
  level: GrantLevel,
): React.ReactNode {
  return (
    <Select.Item
      key={level}
      value={`${LEVEL_PREFIX}${level}`}
      disabled={
        !capabilities.some(inLevel.bind(null, level, fixedIntegration))
      }
    >
      {levelLabel(level)}
    </Select.Item>
  );
}

/** What one press of a level gives, and the resource that it shares. */
function renderLevelFields(
  level: GrantLevel,
  plan: LevelPlan,
  subject: AccessControlOption | null,
  resourceRef: string,
  setResourceRef: React.Dispatch<React.SetStateAction<string>>,
): React.ReactNode {
  const needsChoice = plan.asksResource && plan.shared.length > 1;
  const actions =
    subject === null
      ? plan.candidates.map(capabilityLabel)
      : plan.drafts.map(draftLabel);
  return (
    <>
      {needsChoice
        ? renderResourceField(
            "Resource",
            "Select a resource",
            plan.shared,
            null,
            resourceRef,
            setResourceRef,
          )
        : null}
      <p className="access35-grant-note">
        {actions.length > 0
          ? `Gives ${actions.length === 1 ? "1 action" : `${actions.length} actions`}: ${actions.join(", ")}. Actions that change data stay one at a time.`
          : plan.unresolved === 0
            ? `${subject?.label ?? "This person"} already has every ${level === "view" ? "read" : "read and prepare"} action of this system.`
            : needsChoice
              ? "Choose the resource that these actions use."
              : "No resource of this account is ready for these actions yet."}
      </p>
    </>
  );
}

function capabilityLabel(capability: AccessControlCapabilityView): string {
  return capability.definition.label;
}

function draftLabel(draft: GrantDraft): string {
  return draft.capability.definition.label;
}

function submitLevel(
  levels: GrantFormProps["levels"],
  drafts: readonly GrantDraft[],
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  if (levels !== null && drafts.length > 0) levels.submit(drafts);
}

/**
 * The resource choice of an action. One resource that fits shows as a line,
 * not as a choice of one.
 */
function renderResourceField(
  label: string,
  placeholder: string,
  resources: readonly AccessControlOption[],
  onlyResource: AccessControlOption | null,
  resourceRef: string,
  setResourceRef: React.Dispatch<React.SetStateAction<string>>,
): React.ReactNode {
  if (onlyResource !== null)
    return (
      <p className="access35-grant-note">
        On {onlyResource.label} · {onlyResource.detail}
      </p>
    );
  return (
    <div>
      <label htmlFor="access35-grant-resource">{label}</label>
      <Select.Root
        required
        items={resources.map(optionItem)}
        value={resourceRef === "" ? null : resourceRef}
        onValueChange={(value) => setResourceRef(value ?? "")}
      >
        <Select.Trigger id="access35-grant-resource">
          <Select.Value placeholder={placeholder} />
        </Select.Trigger>
        <Select.Popup>{resources.map(renderOption)}</Select.Popup>
      </Select.Root>
    </div>
  );
}

function initialCapabilityId(
  customHandoff: CustomConnectorAccessHandoff | null,
  provider: FileResourceAccount["provider"] | null,
): string {
  return customHandoff !== null
    ? "custom_connector.read"
    : provider === null
      ? ""
      : "file.read";
}

function syncGrantDefaults(
  active: boolean,
  provider: FileResourceAccount["provider"] | null,
  subjectRef: string,
  customHandoff: CustomConnectorAccessHandoff | null,
  setCustomSelection: React.Dispatch<
    React.SetStateAction<CustomOperationSelection | null>
  >,
  setSubjectRef: React.Dispatch<React.SetStateAction<string>>,
  setCapabilityId: React.Dispatch<React.SetStateAction<string>>,
  setIntegrationRef: React.Dispatch<React.SetStateAction<string>>,
  setResourceRef: React.Dispatch<React.SetStateAction<string>>,
  setFileSelection: React.Dispatch<
    React.SetStateAction<FileResourceSelection | null>
  >,
  setFormProblem: React.Dispatch<React.SetStateAction<string>>,
): void {
  if (!active) return;
  setSubjectRef(subjectRef);
  setCustomSelection(null);
  setCapabilityId(initialCapabilityId(customHandoff, provider));
  setIntegrationRef("");
  setResourceRef("");
  setFileSelection(null);
  setFormProblem("");
}

function submitGrant(
  props: GrantFormProps,
  subjectRef: string,
  capabilityId: string,
  integrationRef: string,
  resourceRef: string,
  customEntityType: string,
  fileSelection: FileResourceSelection | null,
  customSelection: CustomOperationSelection | null,
  setFormProblem: React.Dispatch<React.SetStateAction<string>>,
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  setFormProblem("");
  const subject = findOption(props.subjects, subjectRef);
  const capability = findCapability(props.capabilities, capabilityId);
  const integration =
    integrationRef.length === 0
      ? null
      : findOption(props.integrations, integrationRef);
  const resource =
    resourceRef.length === 0 ? null : findOption(props.resources, resourceRef);
  if (subject === null || capability === null) return;
  switch (capability.definition.target) {
    case "custom_connector_operation":
      if (
        customSelection !== null &&
        customSelection.capabilityId === capability.definition.capabilityId
      ) {
        props.submit({
          kind: "custom_connector_operation",
          subject,
          capability,
          selection: customSelection,
        });
      } else {
        setFormProblem(
          "Choose an approved operation on a connected account before granting access.",
        );
      }
      return;
    case "platform":
      props.submit({ kind: "platform", subject, capability });
      return;
    case "provider_resource":
      if (
        isCommerceActionPropose(capability) &&
        resource?.kind === "commerce_target"
      ) {
        props.submit({
          kind: "published_commerce_target",
          subject,
          capability,
          resource,
        });
      } else if (integration !== null && resource !== null) {
        props.submit({
          kind: "provider_resource",
          subject,
          capability,
          integration,
          resource,
        });
      }
      return;
    case "file_resource":
      if (fileSelection !== null) {
        props.submit({
          kind: "file_resource",
          subject,
          capability,
          selection: fileSelection,
        });
      } else {
        setFormProblem(
          "Choose a current file or folder before granting access.",
        );
      }
      return;
    case "commerce_read":
      if (resource !== null) {
        props.submit({
          kind: "existing_target",
          subject,
          capability,
          resource,
        });
        return;
      }
      try {
        if (
          resourceRef !== "custom_entity_type" &&
          !resourceRef.startsWith("entity_type:")
        ) {
          setFormProblem(
            "Choose a commerce scope before granting read access.",
          );
          return;
        }
        const entityTypeId = parseEntityTypeId(
          resourceRef === "custom_entity_type"
            ? { origin: "custom", typeId: customEntityType.trim() }
            : {
                origin: "system",
                typeId: resourceRef.slice("entity_type:".length),
              },
        );
        props.submit({
          kind: "commerce_entity_type",
          subject,
          capability,
          entityTypeId,
        });
      } catch {
        setFormProblem("Choose a record type before granting read access.");
      }
      return;
    case "commerce_command":
      if (isPublishedCommerceListEntryPatch(capability)) {
        if (resource?.kind === "commerce_target") {
          props.submit({
            kind: "published_commerce_target",
            subject,
            capability,
            resource,
          });
        }
      } else if (resource !== null) {
        props.submit({
          kind: "existing_target",
          subject,
          capability,
          resource,
        });
      }
      return;
  }
}

const COMMERCE_SCOPE_ITEMS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "custom_entity_type", label: "Custom record type" },
  ...SYSTEM_KINDS.map(entityTypeItem),
];

function entityTypeItem(
  kind: SystemCommerceEntityKind,
): Readonly<{ value: string; label: string }> {
  return {
    value: `entity_type:${kind}`,
    label: `All ${kind.replaceAll("_", " ")} records`,
  };
}

function renderEntityTypeOption(
  kind: SystemCommerceEntityKind,
): React.ReactNode {
  return (
    <Select.Item key={kind} value={`entity_type:${kind}`}>
      All {kind.replaceAll("_", " ")} records
    </Select.Item>
  );
}

function isPublishedCommerceListEntryPatch(
  capability: AccessControlCapabilityView,
): boolean {
  return (
    capability.definition.capabilityId === "commerce.list_entry.patch" &&
    capability.definition.capabilityVersion === 1
  );
}

function isCommerceActionPropose(
  capability: AccessControlCapabilityView,
): boolean {
  return (
    capability.definition.capabilityId === "commerce.action.propose" &&
    capability.definition.capabilityVersion === 1
  );
}

function isCommerceTargetOption(option: AccessControlOption): boolean {
  return option.kind === "commerce_target";
}

/**
 * One loader fills the option list of the chosen action, so that two loads
 * never race for the same list.
 */
function changeCapability(
  setCapability: React.Dispatch<React.SetStateAction<string>>,
  setIntegration: React.Dispatch<React.SetStateAction<string>>,
  setResource: React.Dispatch<React.SetStateAction<string>>,
  capabilities: readonly AccessControlCapabilityView[],
  fixedIntegration: AccessControlOption | null,
  chooseCapability: (
    capability: AccessControlCapabilityView | null,
    integration: AccessControlOption | null,
  ) => void,
  chooseIntegration: (integration: AccessControlOption | null) => void,
  setFileSelection: React.Dispatch<
    React.SetStateAction<FileResourceSelection | null>
  >,
  setFormProblem: React.Dispatch<React.SetStateAction<string>>,
  value: string | null,
): void {
  const capabilityId = value ?? "";
  setCapability(capabilityId);
  setIntegration("");
  setResource("");
  setFileSelection(null);
  setFormProblem("");
  if (parseLevel(capabilityId) === null) {
    chooseCapability(
      findCapability(capabilities, capabilityId),
      fixedIntegration,
    );
    return;
  }
  // A level lists the account's resources: its actions share one of them.
  chooseCapability(null, null);
  if (fixedIntegration !== null) chooseIntegration(fixedIntegration);
}

function changeIntegration(
  options: readonly AccessControlOption[],
  setIntegration: React.Dispatch<React.SetStateAction<string>>,
  setResource: React.Dispatch<React.SetStateAction<string>>,
  choose: (integration: AccessControlOption | null) => void,
  value: string | null,
): void {
  const ref = value ?? "";
  setIntegration(ref);
  setResource("");
  choose(findOption(options, ref));
}

function findCapability(
  capabilities: readonly AccessControlCapabilityView[],
  capabilityId: string,
): AccessControlCapabilityView | null {
  for (const capability of capabilities) {
    if (capability.definition.capabilityId === capabilityId) return capability;
  }
  return null;
}

type CapabilityOptionGroup = Readonly<{
  category: string;
  capabilities: readonly AccessControlCapabilityView[];
}>;

function groupCapabilityOptions(
  capabilities: readonly AccessControlCapabilityView[],
): readonly CapabilityOptionGroup[] {
  const categories = new Map<string, AccessControlCapabilityView[]>();
  for (const capability of capabilities) {
    const existing = categories.get(capability.definition.category);
    if (existing === undefined)
      categories.set(capability.definition.category, [capability]);
    else existing.push(capability);
  }
  const groups: CapabilityOptionGroup[] = [];
  for (const [category, grouped] of categories)
    groups.push({ category, capabilities: grouped });
  return groups;
}

function renderCapabilityGroup(group: CapabilityOptionGroup): React.ReactNode {
  return (
    <Select.Group key={group.category}>
      <Select.GroupLabel>{categoryLabel(group.category)}</Select.GroupLabel>
      {group.capabilities.map(renderCapabilityOption)}
    </Select.Group>
  );
}

function capabilityItem(
  capability: AccessControlCapabilityView,
): Readonly<{ value: string; label: string }> {
  return {
    value: capability.definition.capabilityId,
    label: capabilityOptionLabel(capability),
  };
}

function capabilityOptionLabel(
  capability: AccessControlCapabilityView,
): string {
  const unavailable = capability.availability !== "available";
  return `${capability.definition.label}${
    unavailable && capability.definition.providerDependency.kind !== "none"
      ? ` · needs ${providerDependencyLabel(capability.definition.providerDependency)}`
      : ""
  }`;
}

function renderCapabilityOption(
  capability: AccessControlCapabilityView,
): React.ReactNode {
  return (
    <Select.Item
      key={`${capability.definition.capabilityId}@${capability.definition.capabilityVersion}`}
      value={capability.definition.capabilityId}
      disabled={capability.availability !== "available"}
    >
      {capabilityOptionLabel(capability)}
    </Select.Item>
  );
}

/**
 * An account step only offers accounts that can satisfy the chosen
 * capability's provider dependency, so a later step can never contradict an
 * earlier one.
 */
function matchesCapabilityResource(
  capabilityId: string,
  option: AccessControlOption,
): boolean {
  const operational = option.refId === "provider_resource:operational";
  return capabilityId === "email.operational.propose"
    ? operational
    : !operational;
}

function compatibleIntegrations(
  integrations: readonly AccessControlOption[],
  providers: ReadonlyMap<string, string>,
  capability: AccessControlCapabilityView | null,
): readonly AccessControlOption[] {
  const dependency = capability?.definition.providerDependency;
  if (dependency === undefined || dependency.kind !== "provider")
    return integrations;
  const accepted = new Set<string>(dependency.providers);
  const compatible: AccessControlOption[] = [];
  for (const integration of integrations) {
    const provider = providers.get(integration.refId);
    if (provider === undefined || accepted.has(provider))
      compatible.push(integration);
  }
  return compatible;
}

function changeCustomEntityType(
  setValue: React.Dispatch<React.SetStateAction<string>>,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  setValue(event.currentTarget.value);
}
