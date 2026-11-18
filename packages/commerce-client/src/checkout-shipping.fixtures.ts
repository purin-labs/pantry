import type { ShippingRouteBinding } from "@seams/commerce-contracts";
import type { CommerceBuyerShippingServiceV1 } from "./index.ts";

// @ts-expect-error Singapore routes require an exact duty capability binding.
const singaporeWithoutDuty: ShippingRouteBinding = {
  kind: "japan_to_singapore",
  routeId: "route_jp_sg_fixture",
  zoneId: "zone_singapore_fixture",
  carrierRateCapabilityId: "carrier_rate_fixture",
  serviceCodes: ["ems_fixture"],
  incoterm: "ddp",
};

// @ts-expect-error Singapore routes require an exact DDP or DAP incoterm.
const singaporeWithoutIncoterm: ShippingRouteBinding = {
  kind: "japan_to_singapore",
  routeId: "route_jp_sg_without_incoterm",
  zoneId: "zone_singapore_fixture",
  carrierRateCapabilityId: "carrier_rate_fixture",
  serviceCodes: ["ems_fixture"],
  dutyCapabilityId: "duty_fixture",
};

const domesticWithDuty: ShippingRouteBinding = {
  kind: "domestic_japan",
  routeId: "route_jp_domestic_fixture",
  zoneId: "zone_domestic_fixture",
  carrierRateCapabilityId: "carrier_rate_fixture",
  serviceCodes: ["takkyubin_fixture"],
  // @ts-expect-error Domestic routes cannot carry an international duty capability.
  dutyCapabilityId: "duty_fixture",
};

const domesticWithIncoterm: ShippingRouteBinding = {
  kind: "domestic_japan",
  routeId: "route_jp_domestic_incoterm_fixture",
  zoneId: "zone_domestic_fixture",
  carrierRateCapabilityId: "carrier_rate_fixture",
  serviceCodes: ["takkyubin_fixture"],
  // @ts-expect-error Domestic routes cannot carry an international duty incoterm.
  incoterm: "ddp",
};

const unavailableServiceWithoutRecovery: CommerceBuyerShippingServiceV1 = {
  destinationCountry: "SG",
  service: { code: "ems_fixture", name: "EMS fixture" },
  // @ts-expect-error Unavailable buyer services require exact recovery guidance.
  availability: { state: "temporarily_unavailable" },
};

const availableServiceWithRecovery: CommerceBuyerShippingServiceV1 = {
  destinationCountry: "JP",
  service: { code: "takkyubin_fixture", name: "Takkyubin fixture" },
  availability: {
    state: "available",
    // @ts-expect-error Available services cannot carry recovery guidance.
    recovery: "try_again_later",
  },
};

void singaporeWithoutDuty;
void singaporeWithoutIncoterm;
void domesticWithDuty;
void domesticWithIncoterm;
void unavailableServiceWithoutRecovery;
void availableServiceWithRecovery;
