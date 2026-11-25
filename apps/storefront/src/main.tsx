import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import "./patisserie.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Storefront root is missing");

const storefrontRoot = createRoot(root);
void renderStorefrontRoute(window.location.pathname);

async function renderStorefrontRoute(pathname: string): Promise<void> {
  const { StorefrontRoute } =
    pathname === "/store/shipping"
      ? await import("./routes/shipping.tsx")
      : await import("./routes/cafe.tsx");
  storefrontRoot.render(
    <StrictMode>
      <StorefrontRoute />
    </StrictMode>,
  );
}
