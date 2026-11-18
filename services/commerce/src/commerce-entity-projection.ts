import type { CommerceDatabase } from "./database.ts";

export type FoodServiceEntityProjection = Readonly<{
  entityOrigin: "system";
  entityType: string;
  entityId: string;
  revision: number;
  updatedAt: string;
  displayName: string;
}>;

export type FoodServiceEntityProjectionWriter = (
  database: CommerceDatabase,
  merchantId: string,
  projection: FoodServiceEntityProjection,
) => void;
