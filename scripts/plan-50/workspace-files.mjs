import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readWorkspaceFixture(repository) {
  const root = join(
    repository,
    "packages/contracts/fixtures/product-folder-v1",
  );
  const productRoot = "products/product_field_watch";
  const workspaceId = "workspace_plan50_seams";
  const workspace = (await readFile(join(root, "workspace.yaml"), "utf8"))
    .replace("organisation_demo", "organisation_plan50_seams")
    .replace("workspace_018f7556-2511-71b2-8a25-23f9ef9a1970", workspaceId);
  const product = await readFile(join(root, productRoot, "product.md"), "utf8");
  const variants = await readFile(
    join(root, productRoot, "variants.yaml"),
    "utf8",
  );
  return {
    workspaceId,
    productRoot,
    files: [
      { path: "workspace.yaml", mediaType: "text/yaml", content: workspace },
      {
        path: `${productRoot}/product.md`,
        mediaType: "text/markdown",
        content: product,
      },
      {
        path: `${productRoot}/variants.yaml`,
        mediaType: "text/yaml",
        content: variants,
      },
    ],
    candidate: {
      productMarkdown: product.replaceAll("Field Watch", "Field Watch II"),
      variantsYaml: variants,
    },
  };
}
