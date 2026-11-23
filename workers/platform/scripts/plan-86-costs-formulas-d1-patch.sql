-- Plan 86 Phase 4: Per-product COGS/Waste overrides and fx formula JSON in regional D1.
ALTER TABLE bakery_cost_product_plan ADD COLUMN cogs_override_minor INTEGER CHECK (cogs_override_minor IS NULL OR cogs_override_minor >= 0);
ALTER TABLE bakery_cost_product_plan ADD COLUMN waste_override_minor INTEGER CHECK (waste_override_minor IS NULL OR waste_override_minor >= 0);
ALTER TABLE bakery_cost_product_plan ADD COLUMN formulas_json TEXT;
