/**
 * The status vocabulary shared by every chip in the console. It lives apart
 * from the component so presentation logic can classify state without pulling
 * JSX into its import graph.
 */
export type StatusChipStatus =
  | { readonly kind: "neutral"; readonly label: string }
  | { readonly kind: "info"; readonly label: string }
  | { readonly kind: "success"; readonly label: string }
  | { readonly kind: "warning"; readonly label: string }
  | { readonly kind: "danger"; readonly label: string };
