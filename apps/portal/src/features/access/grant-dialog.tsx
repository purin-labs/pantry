import { Select } from "../../ui/select";
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

export function GrantAccessDialog(
  props: Readonly<{
    organisationId: string;
    initialCustomConnector: CustomConnectorAccessHandoff | null;
    open: boolean;
    busy: boolean;
    problem: string | null;
    initialFileProvider: FileResourceAccount["provider"] | null;
    initialSubjectRef: string;
    /** The system the dialog opened from; its actions are the only choices. */
    scopeLabel: string | null;
    capabilities: readonly AccessControlCapabilityView[];
    subjects: readonly AccessControlOption[];
    integrations: readonly AccessControlOption[];
    integrationProviders: ReadonlyMap<string, string>;
    integrationsPath: string | null;
    resources: readonly AccessControlOption[];
    fileAccounts: readonly FileResourceAccount[];
    filePicker: FileResourcePickerTransport;
    close: () => void;
    chooseCapability: (capability: AccessControlCapabilityView | null) => void;
    chooseIntegration: (integration: AccessControlOption | null) => void;
    submit: (draft: GrantDraft) => void;
  }>,
): React.ReactNode {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const [subjectRef, setSubjectRef] = React.useState(props.initialSubjectRef);
  const [capabilityId, setCapabilityId] = React.useState(
    props.initialFileProvider === null ? "" : "file.read",
  );
  const [integrationRef, setIntegrationRef] = React.useState("");
  const [resourceRef, setResourceRef] = React.useState("");
  const [customEntityType, setCustomEntityType] = React.useState("");
  const [fileSelection, setFileSelection] =
    React.useState<FileResourceSelection | null>(null);
  const [customSelection, setCustomSelection] =
    React.useState<CustomOperationSelection | null>(null);
  const [formProblem, setFormProblem] = React.useState("");
  React.useEffect(syncDialog.bind(null, dialog, props.open), [props.open]);
  React.useEffect(
    syncGrantDefaults.bind(
      null,
      props.open,
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
      props.open,
      props.initialFileProvider,
      props.initialSubjectRef,
      props.initialCustomConnector,
    ],
  );
  const initialFileFlow = props.initialFileProvider !== null;
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
  const accounts = compatibleIntegrations(
    props.integrations,
    props.integrationProviders,
    capability,
  );
  const accountMissing = needsAccount && accounts.length === 0;
  const resources = props.resources.filter(
    matchesCapabilityResource.bind(null, capabilityId),
  );
  return (
    <dialog
      className="access35-dialog"
      ref={dialog}
      aria-labelledby="access35-grant-dialog-title"
      onCancel={cancelDialog.bind(null, props.close)}
    >
      <form
        method="dialog"
        onSubmit={submitGrant.bind(
          null,
          props,
          subjectRef,
          capabilityId,
          integrationRef,
          resourceRef,
          customEntityType,
          fileSelection,
          customSelection,
          setFormProblem,
        )}
      >
        <DialogHeading
          id="access35-grant-dialog-title"
          title={
            initialFileFlow
              ? "Choose files for Purin Pantry"
              : props.scopeLabel === null
                ? "Grant access"
                : `Share ${props.scopeLabel}`
          }
          close={props.close}
        />
        <p>
          {initialFileFlow
            ? "Choose files or folders, then confirm where Pantry can use them. Access is read-only."
            : "Choose who gets access, then the exact action and resource."}
        </p>
        <ol className="access35-dialog-steps" aria-label="Grant access steps">
          {initialFileFlow ? (
            <>
              <li>
                <span>1. Files or folders</span>
                <FileResourcePicker
                  accounts={props.fileAccounts}
                  selection={fileSelection}
                  change={setFileSelection}
                  transport={props.filePicker}
                />
              </li>
              <li>
                <label htmlFor="access35-grant-subject">2. Available in</label>
                <Select.Root
                  required
                  items={props.subjects.map(optionItem)}
                  value={subjectRef === "" ? null : subjectRef}
                  onValueChange={(value) => setSubjectRef(value ?? "")}
                >
                  <Select.Trigger id="access35-grant-subject">
                    <Select.Value placeholder="Choose where Pantry can use these files" />
                  </Select.Trigger>
                  <Select.Popup>
                    {props.subjects.map(renderOption)}
                  </Select.Popup>
                </Select.Root>
              </li>
              <li className="access35-dialog-review">
                <span>3. Review</span>
                <p>
                  Pantry can read the selected files in{" "}
                  {subject?.label ?? "the conversation or workflow you choose"}.
                  You can remove access at any time from this page.
                </p>
              </li>
            </>
          ) : (
            <>
              <li>
                <label htmlFor="access35-grant-subject">
                  1. Who gets access
                </label>
                <Select.Root
                  required
                  items={props.subjects.map(optionItem)}
                  value={subjectRef === "" ? null : subjectRef}
                  onValueChange={(value) => setSubjectRef(value ?? "")}
                >
                  <Select.Trigger id="access35-grant-subject" autoFocus>
                    <Select.Value placeholder="Select a person, channel, or agent" />
                  </Select.Trigger>
                  <Select.Popup>
                    {props.subjects.map(renderOption)}
                  </Select.Popup>
                </Select.Root>
              </li>
              <li>
                <label htmlFor="access35-grant-capability">
                  2. What they can do
                </label>
                <Select.Root
                  required
                  items={props.capabilities.map(capabilityItem)}
                  value={capabilityId === "" ? null : capabilityId}
                  onValueChange={changeCapability.bind(
                    null,
                    setCapabilityId,
                    setIntegrationRef,
                    setResourceRef,
                    props.capabilities,
                    props.chooseCapability,
                    props.chooseIntegration,
                    setFileSelection,
                    setFormProblem,
                  )}
                >
                  <Select.Trigger id="access35-grant-capability">
                    <Select.Value placeholder="Select an action" />
                  </Select.Trigger>
                  <Select.Popup>
                    {groupCapabilityOptions(props.capabilities).map(
                      renderCapabilityGroup,
                    )}
                  </Select.Popup>
                </Select.Root>
                {capability?.definition.risk === "external_effect" ? (
                  <p className="access35-inline-alert">
                    <CircleAlert aria-hidden="true" size={18} />
                    {capability.definition.target ===
                    "custom_connector_operation"
                      ? "Allows real changes through the selected API operation. Every write requires approval."
                      : `Allows real changes at ${providerDependencyLabel(capability.definition.providerDependency)}. Capability policy can require an approval for each use.`}
                  </p>
                ) : null}
              </li>
              {props.open &&
              capability?.definition.target === "custom_connector_operation" &&
              (capabilityId === "custom_connector.read" ||
                capabilityId === "custom_connector.write") ? (
                <li>
                  <CustomOperationPicker
                    key={capabilityId}
                    organisationId={props.organisationId}
                    capabilityId={capabilityId}
                    initial={props.initialCustomConnector}
                    selection={customSelection}
                    change={setCustomSelection}
                  />
                </li>
              ) : accountMissing ? (
                <li>
                  <span>3. Connected account</span>
                  <p className="access35-inline-alert" role="status">
                    <CircleAlert aria-hidden="true" size={18} />
                    {capability === null
                      ? "No connected account is available for this capability."
                      : `No ${providerDependencyLabel(capability.definition.providerDependency)} account is connected yet.`}
                    {props.integrationsPath === null ||
                    capability === null ? null : (
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
                </li>
              ) : needsAccount ? (
                <>
                  <li>
                    <label htmlFor="access35-grant-account">
                      3. Connected account
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
                      <Select.Popup>
                        {accounts.map(renderOption)}
                      </Select.Popup>
                    </Select.Root>
                  </li>
                  <li>
                    <label htmlFor="access35-grant-resource">4. Resource</label>
                    <Select.Root
                      required
                      items={resources.map(optionItem)}
                      value={resourceRef === "" ? null : resourceRef}
                      onValueChange={(value) => setResourceRef(value ?? "")}
                    >
                      <Select.Trigger id="access35-grant-resource">
                        <Select.Value placeholder="Select a resource" />
                      </Select.Trigger>
                      <Select.Popup>
                        {resources.map(renderOption)}
                      </Select.Popup>
                    </Select.Root>
                  </li>
                </>
              ) : needsFile ? (
                <li>
                  <span>3. File or folder</span>
                  <FileResourcePicker
                    accounts={props.fileAccounts}
                    selection={fileSelection}
                    change={setFileSelection}
                    transport={props.filePicker}
                  />
                </li>
              ) : needsEntityType ? (
                <li>
                  <label htmlFor="access35-grant-resource">
                    3. Commerce scope
                  </label>
                  <Select.Root
                    required
                    items={[
                      ...COMMERCE_SCOPE_ITEMS,
                      ...resources.map(optionItem),
                    ]}
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
                </li>
              ) : needsResource ? (
                <li>
                  <label htmlFor="access35-grant-resource">
                    {needsPublishedCommerceTarget
                      ? "3. Published commerce list entry"
                      : "3. Existing exact scope"}
                  </label>
                  <Select.Root
                    required
                    items={resources.map(optionItem)}
                    value={resourceRef === "" ? null : resourceRef}
                    onValueChange={(value) => setResourceRef(value ?? "")}
                  >
                    <Select.Trigger id="access35-grant-resource">
                      <Select.Value
                        placeholder={
                          needsPublishedCommerceTarget
                            ? "Select a published list entry"
                            : "Select an existing scope"
                        }
                      />
                    </Select.Trigger>
                    <Select.Popup>{resources.map(renderOption)}</Select.Popup>
                  </Select.Root>
                  {props.resources.length === 0 ? (
                    <p className="access35-inline-alert" role="status">
                      <CircleAlert aria-hidden="true" size={18} />
                      {needsPublishedCommerceTarget
                        ? "No published commerce list entry is available for this capability."
                        : "No current scope is available for this capability."}
                    </p>
                  ) : null}
                </li>
              ) : capability === null ? null : (
                <li className="access35-dialog-review">
                  <span>3. Review</span>
                  <p>{capability.definition.description}</p>
                </li>
              )}
            </>
          )}
        </ol>
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
          <button type="button" className="secondary" onClick={props.close}>
            Cancel
          </button>
          <button
            type="submit"
            className="connection-primary-action"
            disabled={
              props.busy ||
              accountMissing ||
              ((initialFileFlow ||
                capability?.definition.target === "file_resource") &&
                fileSelection === null) ||
              (capability?.definition.target === "custom_connector_operation" &&
                (customSelection === null ||
                  customSelection.capabilityId !== capabilityId))
            }
          >
            {props.busy
              ? initialFileFlow
                ? "Adding files…"
                : "Granting access…"
              : initialFileFlow
                ? "Add files to Pantry"
                : "Grant access"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function syncGrantDefaults(
  open: boolean,
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
  if (!open) return;
  setSubjectRef(subjectRef);
  setCustomSelection(null);
  setCapabilityId(
    customHandoff !== null
      ? "custom_connector.read"
      : provider === null
        ? ""
        : "file.read",
  );
  setIntegrationRef("");
  setResourceRef("");
  setFileSelection(null);
  setFormProblem("");
}

export function RevokeGrantDialog(
  props: Readonly<{
    grant: AccessControlGrantView | null;
    busy: boolean;
    close: () => void;
    revoke: (grant: AccessControlGrantView) => void;
  }>,
): React.ReactNode {
  const dialog = React.useRef<HTMLDialogElement>(null);
  React.useEffect(syncDialog.bind(null, dialog, props.grant !== null), [
    props.grant,
  ]);
  if (props.grant === null) return <dialog ref={dialog} />;
  return (
    <dialog
      className="access35-dialog"
      ref={dialog}
      aria-labelledby="access35-revoke-dialog-title"
      onCancel={cancelDialog.bind(null, props.close)}
    >
      <form
        method="dialog"
        onSubmit={submitRevoke.bind(null, props.revoke, props.grant)}
      >
        <DialogHeading
          id="access35-revoke-dialog-title"
          title="Remove access"
          close={props.close}
        />
        <p>
          {props.grant.subject.label} will lose {props.grant.capability.label}{" "}
          for {props.grant.resource.label} at once.
        </p>
        <dl className="access35-dialog-review">
          <div>
            <dt>Who</dt>
            <dd>{props.grant.subject.label}</dd>
          </div>
          <div>
            <dt>Action</dt>
            <dd>{props.grant.capability.label}</dd>
          </div>
          <div>
            <dt>On</dt>
            <dd>{props.grant.resource.label}</dd>
          </div>
        </dl>
        <div className="access35-dialog-actions">
          <button
            type="button"
            className="secondary"
            autoFocus
            onClick={props.close}
          >
            Keep access
          </button>
          <button type="submit" className="danger" disabled={props.busy}>
            {props.busy ? "Removing access…" : "Remove access"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function submitGrant(
  props: Parameters<typeof GrantAccessDialog>[0],
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

function submitRevoke(
  revoke: (grant: AccessControlGrantView) => void,
  grant: AccessControlGrantView,
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  revoke(grant);
}

function changeCapability(
  setCapability: React.Dispatch<React.SetStateAction<string>>,
  setIntegration: React.Dispatch<React.SetStateAction<string>>,
  setResource: React.Dispatch<React.SetStateAction<string>>,
  capabilities: readonly AccessControlCapabilityView[],
  chooseCapability: (capability: AccessControlCapabilityView | null) => void,
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
  chooseCapability(findCapability(capabilities, capabilityId));
  chooseIntegration(null);
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
