import React from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import { withClass } from "./class-name";
import "./button.css";

export type ButtonVariant = "primary" | "secondary" | "danger" | "link";

export type ButtonProps = BaseButton.Props &
  React.RefAttributes<HTMLElement> & {
    /**
     * The role of the action. `primary` is the main action of a page or a
     * dialog, `secondary` each other action, `danger` an action that removes
     * or stops something, and `link` an action that reads as text.
     */
    variant?: ButtonVariant;
    /** `lg` is the main action at the foot of a page or a dialog. */
    size?: "md" | "lg";
  };

/**
 * The Portal button built on Base UI Button
 * (https://base-ui.com/react/components/button). It renders
 * `<button type="button">`; pass `type="submit"` in a form.
 */
export function Button({
  className,
  variant = "secondary",
  size = "md",
  ...props
}: ButtonProps): React.ReactNode {
  return (
    <BaseButton
      className={withClass("pantry-button", className)}
      data-variant={variant}
      data-size={size}
      {...props}
    />
  );
}
