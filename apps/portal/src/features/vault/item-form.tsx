import React from "react";
import { Eye, EyeOff, Plus, X } from "lucide-react";
import {
  normalizeVaultOrigin,
  VAULT_ORIGIN_LIMIT,
  type VaultContact,
  type VaultItemView,
} from "@seams/control-api";
import type { Variant } from "@seams/type-utils";

import { Select } from "../../ui";

type LoginView = Variant<VaultItemView, "website_login">;
type ContactView = Variant<VaultItemView, "contact_profile">;

export type FieldErrors = Readonly<Record<string, string>>;
type Checked<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; errors: FieldErrors }>;

/* ---------- Website login ---------- */

export type LoginDraft = Readonly<{
  label: string;
  origins: readonly string[];
  username: string;
  password: string;
}>;

export function emptyLoginDraft(): LoginDraft {
  return { label: "", origins: [""], username: "", password: "" };
}

export function loginDraftOf(item: LoginView): LoginDraft {
  return {
    label: item.label,
    origins: item.origins.length === 0 ? [""] : item.origins,
    username: item.username,
    password: "",
  };
}

/** Which parts of a login the form shows: all, its details, or its sign-in. */
export type LoginFormPart = "all" | "details" | "sign_in";

export function checkLoginDraft(
  draft: LoginDraft,
  part: LoginFormPart,
): Checked<LoginDraft & Readonly<{ origins: string[] }>> {
  const errors: Record<string, string> = {};
  const origins: string[] = [];
  if (part !== "sign_in") {
    draft.origins.forEach((raw, index) => {
      if (raw.trim() === "") return;
      const origin = normalizeVaultOrigin(raw);
      if (origin === null)
        errors[`origin-${index}`] =
          "Enter a website that starts with https, such as shop.example.com.";
      else if (!origins.includes(origin)) origins.push(origin);
    });
    if (origins.length === 0 && errors["origin-0"] === undefined)
      errors["origin-0"] = "Enter the website where agents sign in.";
  }
  const username = draft.username.trim();
  if (part !== "details") {
    if (username === "") errors.username = "Enter the username or email.";
    if (draft.password === "") errors.password = "Enter the password.";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const label = draft.label.trim() || hostOf(origins[0] ?? "");
  return {
    ok: true,
    value: {
      label: label.slice(0, 80),
      origins,
      username,
      password: draft.password,
    },
  };
}

export function LoginForm(props: {
  readonly idPrefix: string;
  readonly draft: LoginDraft;
  readonly part: LoginFormPart;
  readonly errors: FieldErrors;
  readonly change: (draft: LoginDraft) => void;
}): React.ReactNode {
  const { draft, errors, idPrefix } = props;
  const [revealed, setRevealed] = React.useState(false);
  const firstOrigin = normalizeVaultOrigin(draft.origins[0] ?? "");
  const set = (patch: Partial<LoginDraft>): void =>
    props.change({ ...draft, ...patch });
  return (
    <div className="vault-form-fields">
      {props.part === "sign_in" ? null : (
        <>
          <fieldset className="vault-field-group">
            <legend>Websites</legend>
            <p className="vault-field-hint" id={`${idPrefix}-origins-hint`}>
              Agents fill this login only on these exact websites.
            </p>
            {draft.origins.map((origin, index) => (
              <div className="vault-origin-row" key={index}>
                <Field
                  id={`${idPrefix}-origin-${index}`}
                  label={index === 0 ? "Website" : `Website ${index + 1}`}
                  hiddenLabel
                  describedBy={`${idPrefix}-origins-hint`}
                  error={errors[`origin-${index}`]}
                >
                  {(a11y) => (
                    <input
                      id={`${idPrefix}-origin-${index}`}
                      value={origin}
                      inputMode="url"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="shop.example.com"
                      {...a11y}
                      onChange={(event) =>
                        set({
                          origins: draft.origins.map((value, at) =>
                            at === index ? event.currentTarget.value : value,
                          ),
                        })
                      }
                    />
                  )}
                </Field>
                {draft.origins.length > 1 ? (
                  <button
                    type="button"
                    className="icon-button vault-origin-remove"
                    aria-label={`Remove website ${index + 1}`}
                    onClick={() =>
                      set({
                        origins: draft.origins.filter((_, at) => at !== index),
                      })
                    }
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ))}
            {draft.origins.length < VAULT_ORIGIN_LIMIT ? (
              <button
                type="button"
                className="vault-text-button"
                onClick={() => set({ origins: [...draft.origins, ""] })}
              >
                <Plus size={16} aria-hidden="true" />
                Add another website
              </button>
            ) : null}
          </fieldset>
          <Field
            id={`${idPrefix}-label`}
            label="Name"
            optional
            hint="Shown in the Vault. Leave it empty to use the website."
            error={errors.label}
          >
            {(a11y) => (
              <input
                id={`${idPrefix}-label`}
                value={draft.label}
                maxLength={80}
                autoComplete="off"
                placeholder={firstOrigin === null ? "" : hostOf(firstOrigin)}
                {...a11y}
                onChange={(event) => set({ label: event.currentTarget.value })}
              />
            )}
          </Field>
        </>
      )}
      {props.part === "details" ? null : (
        <>
          <Field
            id={`${idPrefix}-username`}
            label="Username or email"
            error={errors.username}
          >
            {(a11y) => (
              <input
                id={`${idPrefix}-username`}
                value={draft.username}
                maxLength={254}
                autoComplete="off"
                spellCheck={false}
                {...a11y}
                onChange={(event) =>
                  set({ username: event.currentTarget.value })
                }
              />
            )}
          </Field>
          <Field
            id={`${idPrefix}-password`}
            label="Password"
            error={errors.password}
          >
            {(a11y) => (
              <div className="vault-password">
                <input
                  id={`${idPrefix}-password`}
                  type={revealed ? "text" : "password"}
                  value={draft.password}
                  maxLength={1024}
                  autoComplete="new-password"
                  spellCheck={false}
                  {...a11y}
                  onChange={(event) =>
                    set({ password: event.currentTarget.value })
                  }
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={revealed ? "Hide password" : "Show password"}
                  aria-pressed={revealed}
                  onClick={() => setRevealed(!revealed)}
                >
                  {revealed ? (
                    <EyeOff size={18} aria-hidden="true" />
                  ) : (
                    <Eye size={18} aria-hidden="true" />
                  )}
                </button>
              </div>
            )}
          </Field>
          <p className="vault-secret-note">
            Never shown to agents.{" "}
            {firstOrigin === null
              ? "Only filled on the websites above."
              : `Only filled on ${hostOf(firstOrigin)}${draft.origins.filter((o) => o.trim() !== "").length > 1 ? " and the other websites" : ""}.`}
          </p>
        </>
      )}
    </div>
  );
}

/* ---------- Contact profile ---------- */

export type ContactDraft = Readonly<{
  label: string;
  fullName: string;
  company: string;
  email: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  taxRegistrationNumber: string;
}>;

export function emptyContactDraft(): ContactDraft {
  return {
    label: "",
    fullName: "",
    company: "",
    email: "",
    phone: "",
    line1: "",
    line2: "",
    city: "",
    region: "",
    postalCode: "",
    country: "",
    taxRegistrationNumber: "",
  };
}

export function contactDraftOf(item: ContactView): ContactDraft {
  const { contact } = item;
  return {
    label: item.label,
    fullName: contact.fullName,
    company: contact.company ?? "",
    email: contact.email ?? "",
    phone: contact.phone ?? "",
    line1: contact.address?.line1 ?? "",
    line2: contact.address?.line2 ?? "",
    city: contact.address?.city ?? "",
    region: contact.address?.region ?? "",
    postalCode: contact.address?.postalCode ?? "",
    country: contact.address?.country ?? "",
    taxRegistrationNumber: contact.taxRegistrationNumber ?? "",
  };
}

export function checkContactDraft(
  draft: ContactDraft,
): Checked<Readonly<{ label: string; contact: VaultContact }>> {
  const errors: Record<string, string> = {};
  const label = draft.label.trim();
  const fullName = draft.fullName.trim();
  if (label === "") errors.label = "Enter a name, such as Shop or Head office.";
  if (fullName === "") errors.fullName = "Enter the full name.";
  const email = optional(draft.email);
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    errors.email = "Enter an email address, such as name@example.com.";
  const addressParts = [
    draft.line1,
    draft.line2,
    draft.city,
    draft.region,
    draft.postalCode,
    draft.country,
  ];
  const hasAddress = addressParts.some((part) => part.trim() !== "");
  if (hasAddress) {
    if (draft.line1.trim() === "") errors.line1 = "Enter the street address.";
    if (draft.city.trim() === "") errors.city = "Enter the city.";
    if (draft.country === "") errors.country = "Choose the country.";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      label,
      contact: {
        fullName,
        company: optional(draft.company),
        email,
        phone: optional(draft.phone),
        address: hasAddress
          ? {
              line1: draft.line1.trim(),
              line2: optional(draft.line2),
              city: draft.city.trim(),
              region: optional(draft.region),
              postalCode: optional(draft.postalCode),
              country: draft.country,
            }
          : null,
        taxRegistrationNumber: optional(draft.taxRegistrationNumber),
      },
    },
  };
}

/** Asia Pacific first, as the shops that Pantry serves are there. */
const COUNTRY_CODES = [
  "JP",
  "AU",
  "NZ",
  "SG",
  "HK",
  "TW",
  "KR",
  "TH",
  "MY",
  "ID",
  "PH",
  "VN",
  "IN",
  "CN",
  "US",
  "CA",
  "GB",
  "FR",
  "DE",
  "IT",
  "ES",
  "NL",
  "CH",
] as const;

export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const COUNTRY_ITEMS: readonly Readonly<{ value: string; label: string }>[] = [
  { value: "", label: "Choose a country" },
  ...COUNTRY_CODES.map((code) => ({ value: code, label: countryName(code) })),
];

export function ContactForm(props: {
  readonly idPrefix: string;
  readonly draft: ContactDraft;
  readonly errors: FieldErrors;
  readonly change: (draft: ContactDraft) => void;
}): React.ReactNode {
  const { draft, errors, idPrefix } = props;
  const text = (
    key: Exclude<keyof ContactDraft, "country">,
    label: string,
    options: Readonly<{
      optional?: boolean;
      hint?: string;
      maxLength: number;
      autoComplete?: string;
      type?: string;
    }>,
  ): React.ReactNode => (
    <Field
      id={`${idPrefix}-${key}`}
      label={label}
      optional={options.optional}
      hint={options.hint}
      error={errors[key]}
    >
      {(a11y) => (
        <input
          id={`${idPrefix}-${key}`}
          type={options.type ?? "text"}
          value={draft[key]}
          maxLength={options.maxLength}
          autoComplete={options.autoComplete ?? "off"}
          {...a11y}
          onChange={(event) =>
            props.change({ ...draft, [key]: event.currentTarget.value })
          }
        />
      )}
    </Field>
  );
  return (
    <div className="vault-form-fields">
      <fieldset className="vault-field-group">
        <legend>Identity</legend>
        {text("label", "Name", {
          hint: "Shown in the Vault, such as Shop or Head office.",
          maxLength: 80,
        })}
        {text("fullName", "Full name", { maxLength: 120 })}
        {text("company", "Company", { optional: true, maxLength: 120 })}
      </fieldset>
      <fieldset className="vault-field-group">
        <legend>Contact details</legend>
        {text("email", "Email", {
          optional: true,
          maxLength: 254,
          type: "email",
        })}
        {text("phone", "Phone", { optional: true, maxLength: 40, type: "tel" })}
      </fieldset>
      <fieldset className="vault-field-group">
        <legend>
          Address <span className="vault-optional">Optional</span>
        </legend>
        {text("line1", "Street address", { maxLength: 200 })}
        {text("line2", "Address line 2", { optional: true, maxLength: 200 })}
        <div className="vault-field-pair">
          {text("city", "City", { maxLength: 120 })}
          {text("region", "State or prefecture", {
            optional: true,
            maxLength: 120,
          })}
        </div>
        <div className="vault-field-pair">
          {text("postalCode", "Postal code", { optional: true, maxLength: 20 })}
          <Field
            id={`${idPrefix}-country`}
            label="Country"
            error={errors.country}
          >
            {(a11y) => (
              <Select.Root
                items={COUNTRY_ITEMS}
                value={draft.country}
                onValueChange={(country) => {
                  if (country !== null) props.change({ ...draft, country });
                }}
              >
                <Select.Trigger id={`${idPrefix}-country`} {...a11y}>
                  <Select.Value />
                </Select.Trigger>
                <Select.Popup>
                  {COUNTRY_ITEMS.map((country) => (
                    <Select.Item key={country.value} value={country.value}>
                      {country.label}
                    </Select.Item>
                  ))}
                </Select.Popup>
              </Select.Root>
            )}
          </Field>
        </div>
      </fieldset>
      {text("taxRegistrationNumber", "Tax or invoice registration number", {
        optional: true,
        hint: "For example, a Japanese invoice number such as T1234567890123.",
        maxLength: 40,
      })}
    </div>
  );
}

/* ---------- Shared ---------- */

type FieldA11y = Readonly<{
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
}>;

function Field(props: {
  readonly id: string;
  readonly label: string;
  readonly hiddenLabel?: boolean;
  readonly optional?: boolean | undefined;
  readonly hint?: string | undefined;
  readonly describedBy?: string;
  readonly error?: string | undefined;
  readonly children: (a11y: FieldA11y) => React.ReactNode;
}): React.ReactNode {
  const hintId = props.hint === undefined ? undefined : `${props.id}-hint`;
  const errorId = props.error === undefined ? undefined : `${props.id}-error`;
  const describedBy = [props.describedBy, hintId, errorId]
    .filter((id) => id !== undefined)
    .join(" ");
  return (
    <div className="vault-field" data-invalid={props.error !== undefined}>
      <label
        htmlFor={props.id}
        className={props.hiddenLabel ? "visually-hidden" : undefined}
      >
        {props.label}
        {props.optional ? (
          <span className="vault-optional">Optional</span>
        ) : null}
      </label>
      {props.hint === undefined ? null : (
        <p className="vault-field-hint" id={hintId}>
          {props.hint}
        </p>
      )}
      {props.children({
        "aria-describedby": describedBy === "" ? undefined : describedBy,
        "aria-invalid": props.error === undefined ? undefined : true,
      })}
      {props.error === undefined ? null : (
        <p className="vault-field-error" id={errorId}>
          {props.error}
        </p>
      )}
    </div>
  );
}

function optional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
