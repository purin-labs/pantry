export type PageFreshness =
  | { readonly kind: "current" }
  | {
      readonly kind: "delayed";
      readonly observedAt: string;
      readonly explanation: string;
    };

export type PageContent<T> =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly data: T;
      readonly freshness: PageFreshness;
      readonly updating: boolean;
    }
  | {
      readonly kind: "empty";
      readonly reason: string;
      readonly nextAction: { readonly label: string } | null;
    }
  | {
      readonly kind: "failed";
      readonly problem: string;
      readonly recovery: { readonly label: string };
    }
  | { readonly kind: "unauthorized"; readonly reason: string };
