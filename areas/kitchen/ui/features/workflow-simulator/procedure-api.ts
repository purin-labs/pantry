import {
  readBakeryProcedure,
  type ProcedureResult,
} from "@purin-labs/bakery-model/bakery-procedure";
import type { Settings } from "@purin-labs/bakery-model/bakery";
import {
  customEntityRef,
  readCommerceGraph,
} from "@purin-labs/area-commerce-contract/ui/features/commerce/entity-plane/api";

export async function readProcedure(
  organisationId: string,
  procedureId: string,
  assumptions: Settings,
): Promise<ProcedureResult> {
  const reference = customEntityRef("bakery_procedure", procedureId.trim());
  return readBakeryProcedure(
    readCommerceGraph.bind(null, organisationId),
    reference,
    assumptions,
  );
}
