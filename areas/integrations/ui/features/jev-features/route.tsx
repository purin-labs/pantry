import React from "react";
import { useLocation } from "react-router";
import {
  JEV_FEATURE_SENDS,
  type JevFeature,
  type JevFeatureCommand,
  type JevFeaturesView,
  type JevRelatedCasesMode,
} from "@purin-labs/control-api/portal/jev-features";
import { Select } from "@purin-labs/ui/index";
import { Switch } from "@purin-labs/ui/toggle-switch";
import {
  changeJevFeature,
  jevFeatureErrorMessage,
  readJevFeatures,
} from "@purin-labs/area-integrations-contract/ui/features/jev-features/api";
import {
  JEV_PAID_USE_ID,
  JevUsePrompt,
  PaidUseSection,
  microDollars,
  resetDate,
} from "@purin-labs/area-integrations-contract/ui/features/jev-features/paid-use";
import {
  JevFacts,
  type JevFact,
} from "@purin-labs/area-integrations-contract/ui/features/jev-features/facts";
import "@purin-labs/area-integrations-contract/ui/features/jev-features/styles.css";

/**
 * Settings › Jev (Plan 88 section 2): one switch for each Pantry feature that
 * sends data to TypeSafe Jev. Every member reads the switches; an admin
 * changes them.
 */
type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; view: JevFeaturesView }>;

type ChoosableMode = "metadata_only" | "shadow";

const MODE_LABELS: Readonly<Record<JevRelatedCasesMode, string>> = {
  metadata_only: "Suggestions",
  shadow: "Measure only",
  party_context: "Reply context",
};

const MODE_ITEMS: readonly Readonly<{ value: ChoosableMode; label: string }>[] =
  [
    { value: "metadata_only", label: MODE_LABELS.metadata_only },
    { value: "shadow", label: MODE_LABELS.shadow },
  ];

export function JevFeaturesRoute(props: {
  readonly organisationId: string;
  readonly canManage: boolean;
  /** Only the owner turns paid use on or off (Plan 88 section 4). */
  readonly isOwner: boolean;
  /** The Integrations page, where an Organisation keeps its own TypeSafe key. */
  readonly integrationsHref: string | null;
}): React.ReactNode {
  const { organisationId, canManage, isOwner } = props;
  const [load, setLoad] = React.useState<LoadState>({ kind: "loading" });
  const [pending, setPending] = React.useState<JevFeature | null>(null);
  const [errors, setErrors] = React.useState<
    Partial<Record<JevFeature, string>>
  >({});

  const reload = React.useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      setLoad({ kind: "ready", view: await readJevFeatures(organisationId) });
    } catch (error) {
      setLoad({ kind: "failed", message: jevFeatureErrorMessage(error) });
    }
  }, [organisationId]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const paidUseSwitch = React.useRef<HTMLDivElement>(null);
  const focusPaidUse = React.useCallback(() => {
    const section = document.getElementById(JEV_PAID_USE_ID);
    section?.scrollIntoView({ block: "start", behavior: "smooth" });
    const control =
      paidUseSwitch.current?.querySelector<HTMLElement>('[role="switch"]');
    (control ?? section)?.focus({ preventScroll: true });
  }, []);

  // Settings › Billing links to `#jev-paid-use`.
  const { hash } = useLocation();
  const ready = load.kind === "ready";
  React.useEffect(() => {
    if (ready && hash === `#${JEV_PAID_USE_ID}`) focusPaidUse();
  }, [ready, hash, focusPaidUse]);

  const change = async (command: JevFeatureCommand): Promise<void> => {
    setPending(command.feature);
    setErrors((current) => ({ ...current, [command.feature]: undefined }));
    try {
      const view = await changeJevFeature(organisationId, command);
      setLoad({ kind: "ready", view });
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [command.feature]: jevFeatureErrorMessage(error),
      }));
    } finally {
      setPending(null);
    }
  };

  if (load.kind === "loading")
    return (
      <div className="jev-page">
        <p className="jev-muted" role="status">
          Loading Jev settings…
        </p>
      </div>
    );
  if (load.kind === "failed")
    return (
      <div className="jev-page">
        <p role="alert">
          {load.message}{" "}
          <button type="button" onClick={() => void reload()}>
            Retry
          </button>
        </p>
      </div>
    );

  const { view } = load;
  const locked = !canManage;
  const rowProps = (feature: JevFeature) => ({
    busy: pending === feature,
    disabled: locked || (pending !== null && pending !== feature),
    error: errors[feature] ?? null,
  });

  return (
    <div className="jev-page">
      <section className="jev-funding" aria-label="Who pays for Jev">
        <FundingLine view={view} integrationsHref={props.integrationsHref} />
        <JevUsePrompt view={view} isOwner={isOwner} onTurnOn={focusPaidUse} />
      </section>
      {view.funding === "pantry_platform" ? (
        <PaidUseSection
          organisationId={organisationId}
          view={view}
          isOwner={isOwner}
          onView={(next) => setLoad({ kind: "ready", view: next })}
          switchRef={paidUseSwitch}
        />
      ) : null}
      {locked ? (
        <p className="jev-muted">Only an admin can change these switches.</p>
      ) : null}
      <ul className="jev-list">
        <FeatureRow
          id="jev-mail-classification"
          title="Mail classification"
          checked={view.mailClassification.enabled}
          onChange={(enabled) =>
            void change({ feature: "mail_classification", enabled })
          }
          {...rowProps("mail_classification")}
          does="Sorts each new email against your mail rules."
          sends={JEV_FEATURE_SENDS.mail_classification}
        >
          <MailboxList
            enabled={view.mailClassification.enabled}
            mailboxes={view.mailClassification.mailboxes}
          />
        </FeatureRow>
        <FeatureRow
          id="jev-related-cases"
          title="Related Cases"
          checked={view.relatedCases.enabled}
          onChange={(enabled) =>
            void change({ feature: "related_cases", enabled })
          }
          {...rowProps("related_cases")}
          does="Suggests open Cases that relate to new email."
          sends={JEV_FEATURE_SENDS.related_cases}
        >
          {view.relatedCases.enabled ? (
            <ModeChoice
              mode={view.relatedCases.mode}
              disabled={locked || pending !== null}
              onChange={(mode) =>
                void change({ feature: "related_cases", enabled: true, mode })
              }
            />
          ) : null}
        </FeatureRow>
        <FeatureRow
          id="jev-screen-relevance"
          title="Screen relevance"
          checked={view.screenRelevance.enabled}
          onChange={(enabled) =>
            void change({ feature: "screen_relevance", enabled })
          }
          {...rowProps("screen_relevance")}
          does="Finds the part of the screen that your chat question is about."
          sends={JEV_FEATURE_SENDS.screen_relevance}
        />
      </ul>
    </div>
  );
}

function FundingLine(props: {
  readonly view: JevFeaturesView;
  readonly integrationsHref: string | null;
}): React.ReactNode {
  const { view } = props;
  const typesafeHref =
    props.integrationsHref === null
      ? null
      : `${props.integrationsHref}?${new URLSearchParams({ integration: "typesafe" }).toString()}`;
  if (view.funding === "pantry_platform") {
    const { allowance } = view;
    return (
      <>
        <JevFacts
          label="Who pays for Jev"
          rows={[
            ["Paid by", "The Purin TypeSafe key"],
            ...(allowance === null ? [] : [allowanceFact(allowance)]),
            [
              "Feature use",
              "Counts toward the monthly Jev allowance in your subscription",
            ],
          ]}
        />
        {view.keyAvailable ? null : (
          <p className="jev-warning" role="status">
            The Purin key is not set. Jev calls stop until the key is set.
          </p>
        )}
        {allowance?.reached !== true ? null : view.paidUse.enabled ? (
          // The Paid use section says so when the payment or the limit stops it.
          <p className="jev-muted" role="status">
            The free use of this month is used. Paid use covers the Jev features
            until {resetDate(allowance)}.
          </p>
        ) : (
          <p className="jev-warning" role="status">
            The free use of this month is used. Jev features pause until{" "}
            {resetDate(allowance)}.
          </p>
        )}
      </>
    );
  }
  return (
    <>
      <JevFacts
        label="Who pays for Jev"
        rows={[
          [
            "Paid by",
            <>
              Your own TypeSafe key
              {typesafeHref === null ? null : (
                <a href={typesafeHref}>Integrations › TypeSafe</a>
              )}
            </>,
          ],
        ]}
      />
      {view.keyAvailable ? null : (
        <p className="jev-warning" role="status">
          Your key is not set. Jev calls stop until you set the key.
        </p>
      )}
    </>
  );
}

/** The free use of the month (Plan 88 section 3). */
function allowanceFact(
  allowance: NonNullable<JevFeaturesView["allowance"]>,
): JevFact {
  const used = microDollars(
    Math.min(allowance.usedMicrousd, allowance.limitMicrousd),
  );
  return [
    "Free use this month",
    `${used} of ${microDollars(allowance.limitMicrousd)} · starts again on ${resetDate(allowance)}`,
  ];
}

function FeatureRow(props: {
  readonly id: string;
  readonly title: string;
  /** What the feature does, in one line. */
  readonly does: string;
  /** What the feature sends to TypeSafe. */
  readonly sends: string;
  readonly checked: boolean;
  readonly onChange: (enabled: boolean) => void;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly children?: React.ReactNode;
}): React.ReactNode {
  return (
    <li className="jev-row">
      <div className="jev-row-head">
        <h3 id={`${props.id}-title`} className="jev-row-title">
          {props.title}
        </h3>
        <span className="jev-row-state" aria-hidden="true">
          {props.busy ? "Saving…" : props.checked ? "On" : "Off"}
        </span>
        <Switch
          checked={props.checked}
          onCheckedChange={props.onChange}
          busy={props.busy}
          disabled={props.disabled}
          aria-labelledby={`${props.id}-title`}
          aria-describedby={`${props.id}-description ${props.id}-sends`}
        />
      </div>
      <p id={`${props.id}-description`} className="jev-row-description">
        {props.does}
      </p>
      <p id={`${props.id}-sends`} className="jev-row-sends">
        <span>Sends</span> {props.sends}
      </p>
      {props.error === null ? null : (
        <p className="jev-error" role="alert">
          {props.error}
        </p>
      )}
      {props.children}
    </li>
  );
}

function MailboxList(props: {
  readonly enabled: boolean;
  readonly mailboxes: JevFeaturesView["mailClassification"]["mailboxes"];
}): React.ReactNode {
  if (props.mailboxes.length === 0)
    return <p className="jev-muted">No Gmail mailbox is connected.</p>;
  return (
    <ul className="jev-mailboxes" aria-label="Mailboxes">
      {props.mailboxes.map((mailbox) => (
        <li key={mailbox.integrationAccountId} className="jev-mailbox">
          <span className="jev-mailbox-name">{mailbox.displayName}</span>
          <span
            className="jev-mailbox-state"
            data-covered={mailbox.covered ? "" : undefined}
          >
            {mailbox.covered ? "On" : "Not on"}
          </span>
          {props.enabled && !mailbox.covered ? (
            <span className="jev-mailbox-hint">
              To include it, turn the switch off and on.
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ModeChoice(props: {
  readonly mode: JevRelatedCasesMode | null;
  readonly disabled: boolean;
  readonly onChange: (mode: ChoosableMode) => void;
}): React.ReactNode {
  if (props.mode === "party_context")
    return (
      <p className="jev-mode">
        Mode: <strong>{MODE_LABELS.party_context}</strong>
      </p>
    );
  return (
    <div className="jev-mode">
      <span id="jev-related-cases-mode">Mode</span>
      <Select.Root
        items={MODE_ITEMS}
        value={props.mode}
        disabled={props.disabled}
        onValueChange={(mode) => {
          if (mode !== null && mode !== props.mode) props.onChange(mode);
        }}
      >
        <Select.Trigger size="sm" aria-labelledby="jev-related-cases-mode">
          <Select.Value placeholder="Choose a mode" />
        </Select.Trigger>
        <Select.Popup>
          {MODE_ITEMS.map((item) => (
            <Select.Item key={item.value} value={item.value}>
              {item.label}
            </Select.Item>
          ))}
        </Select.Popup>
      </Select.Root>
    </div>
  );
}
