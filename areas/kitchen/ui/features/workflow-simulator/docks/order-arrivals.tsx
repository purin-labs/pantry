import React from "react";
import { Select } from "@purin-labs/ui/select";
import { SideDrawer } from "@purin-labs/ui/index";
import {
  CAFE_BEVERAGE_ROTATION,
  VITRINE_ORDER_CHANNELS,
  addCustomVitrineOrder,
  clock,
  exportCustomVitrineOrdersJson,
  importCustomVitrineOrdersJson,
  nudgeVitrineOrderArrivalMinutes,
  removeCustomVitrineOrder,
  resetCustomVitrineOrders,
  setVitrineOrderArrivalMinutes,
  setVitrineOrderItems,
  shiftAllVitrineOrderArrivals,
  vitrineStockAt,
  type CafeBeverageRecipeId,
  type VitrineOrderChannel,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { downloadBakeryFile } from "../file-download";

const CHANNEL_ITEMS = VITRINE_ORDER_CHANNELS.map((ch) => ({
  value: ch.id,
  label: ch.label,
}));
const BEVERAGE_ITEMS = CAFE_BEVERAGE_ROTATION.map((bev) => ({
  value: bev.recipe,
  label: bev.shortName,
}));

/**
 * The customer orders of the shift, in a side drawer that the Inputs tab
 * opens: move, add or remove an order, change its items, channel and drink,
 * and export or import the schedule as JSON.
 */
export function OrderArrivalsDrawer(
  props: Readonly<{
    open: boolean;
    close(): void;
    vitrine: ReturnType<typeof vitrineStockAt>;
  }>,
): React.ReactNode {
  const { vitrine } = props;
  return (
    <SideDrawer
      open={props.open}
      title="Order arrivals"
      close={props.close}
      className="workflow-order-drawer"
    >
      <div className="side-drawer-body">
        <OrderScheduleControls vitrine={vitrine} />
        <dl className="workflow-plan61a-dl">
          {vitrine.orders.map((ord) => (
            <React.Fragment key={ord.id}>
              <dt title={ord.label}>
                {ord.id} · {ord.channelLabel}
              </dt>
              <dd>
                <span>{clock(ord.orderedAt)}</span>{" "}
                <button
                  type="button"
                  aria-label={`Earlier arrival for ${ord.id}`}
                  onClick={() => nudgeVitrineOrderArrivalMinutes(ord.id, -5)}
                >
                  −5m
                </button>{" "}
                <input
                  type="number"
                  aria-label={`Input arrival minute for ${ord.id}`}
                  min={1}
                  max={180}
                  step={1}
                  value={ord.orderedAtMinutes}
                  style={{ width: "3.6rem" }}
                  onChange={(e) => {
                    const val = Number(e.currentTarget.value);
                    if (Number.isFinite(val) && val >= 1) {
                      setVitrineOrderArrivalMinutes(ord.id, val);
                    }
                  }}
                />
                <small>m</small>{" "}
                <button
                  type="button"
                  aria-label={`Later arrival for ${ord.id}`}
                  onClick={() => nudgeVitrineOrderArrivalMinutes(ord.id, 5)}
                >
                  +5m
                </button>{" "}
                <input
                  type="number"
                  aria-label={`Input ballotin boxes for ${ord.id}`}
                  min={0}
                  max={8}
                  step={1}
                  value={ord.ballotinBoxes}
                  style={{ width: "3rem" }}
                  onChange={(e) => {
                    const val = Number(e.currentTarget.value);
                    if (Number.isFinite(val) && val >= 0) {
                      setVitrineOrderItems(ord.id, { ballotinBoxes: val });
                    }
                  }}
                />
                <small>box</small>{" "}
                <input
                  type="number"
                  aria-label={`Input loose pieces for ${ord.id}`}
                  min={0}
                  max={24}
                  step={1}
                  value={ord.loosePieces}
                  style={{ width: "3.2rem" }}
                  onChange={(e) => {
                    const val = Number(e.currentTarget.value);
                    if (Number.isFinite(val) && val >= 0) {
                      setVitrineOrderItems(ord.id, { loosePieces: val });
                    }
                  }}
                />
                <small>pcs</small>{" "}
                <Select.Root
                  items={CHANNEL_ITEMS}
                  value={ord.channel}
                  onValueChange={(value) => {
                    if (value === null) return;
                    setVitrineOrderItems(ord.id, {
                      channel: value as VitrineOrderChannel,
                    });
                  }}
                >
                  <Select.Trigger
                    aria-label={`Input channel for ${ord.id}`}
                    style={{ maxWidth: "7.8rem" }}
                  >
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Popup>
                    {CHANNEL_ITEMS.map((ch) => (
                      <Select.Item key={ch.value} value={ch.value}>
                        {ch.label}
                      </Select.Item>
                    ))}
                  </Select.Popup>
                </Select.Root>{" "}
                <Select.Root
                  items={BEVERAGE_ITEMS}
                  value={ord.beverageRecipe}
                  onValueChange={(value) => {
                    if (value === null) return;
                    setVitrineOrderItems(ord.id, {
                      beverageRecipe: value as CafeBeverageRecipeId,
                    });
                  }}
                >
                  <Select.Trigger
                    aria-label={`Input beverage recipe for ${ord.id}`}
                    style={{ maxWidth: "9.5rem" }}
                  >
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Popup>
                    {BEVERAGE_ITEMS.map((bev) => (
                      <Select.Item key={bev.value} value={bev.value}>
                        {bev.label}
                      </Select.Item>
                    ))}
                  </Select.Popup>
                </Select.Root>
                {ord.isCustomOrder && (
                  <>
                    {" "}
                    <button
                      type="button"
                      aria-label={`Input remove ${ord.id}`}
                      onClick={() => removeCustomVitrineOrder(ord.id)}
                    >
                      Remove
                    </button>
                  </>
                )}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      </div>
    </SideDrawer>
  );
}

/**
 * The buttons that move, add and reset the customer orders and export or
 * import their schedule as JSON, with the JSON panel. The order drawer and
 * the vitrine details of the inspector share them.
 */
export function OrderScheduleControls(
  props: Readonly<{
    vitrine: ReturnType<typeof vitrineStockAt>;
    /** More buttons after Reset arrivals. */
    afterReset?: React.ReactNode;
    /** More buttons at the end of the row. */
    end?: React.ReactNode;
  }>,
): React.ReactNode {
  const { vitrine } = props;
  const [jsonPanelOpen, setJsonPanelOpen] = React.useState(false);
  const [jsonDraft, setJsonDraft] = React.useState("");
  const [jsonNotice, setJsonNotice] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const jsonId = React.useId();
  return (
    <>
      <div className="workflow-presets" aria-label="Order arrival controls">
        <button
          type="button"
          title="Add a custom customer order arrival to this shift"
          onClick={() => addCustomVitrineOrder()}
        >
          + Add order
        </button>
        <button
          type="button"
          title="Move all customer order arrivals 5 minutes earlier"
          onClick={() => shiftAllVitrineOrderArrivals(-5)}
        >
          Shift -5m
        </button>
        <button
          type="button"
          title="Move all customer order arrivals 5 minutes later"
          onClick={() => shiftAllVitrineOrderArrivals(5)}
        >
          Shift +5m
        </button>
        <button
          type="button"
          disabled={!vitrine.hasCustomArrivals}
          title="Restore default customer order arrival times for this preset"
          onClick={() => resetCustomVitrineOrders()}
        >
          Reset arrivals
        </button>
        {props.afterReset}
        <button
          type="button"
          title="Export custom customer order schedule to JSON"
          onClick={() => {
            const exported = exportCustomVitrineOrdersJson(vitrine.rushPreset);
            setJsonDraft(exported);
            setJsonPanelOpen(true);
            setJsonNotice(
              `Exported ${vitrine.orders.length} orders (${vitrine.rushPreset}) to JSON.`,
            );
          }}
        >
          Export JSON
        </button>
        <button
          type="button"
          aria-expanded={jsonPanelOpen}
          title="Import custom customer order schedule from JSON"
          onClick={() => {
            if (!jsonPanelOpen && jsonDraft.trim().length === 0) {
              setJsonDraft(exportCustomVitrineOrdersJson(vitrine.rushPreset));
            }
            setJsonPanelOpen(!jsonPanelOpen);
            setJsonNotice(null);
          }}
        >
          Import JSON
        </button>
        <button
          type="button"
          aria-label="Download customer order schedule JSON"
          title="Download customer order schedule as a .json file"
          onClick={() => {
            const exported = exportCustomVitrineOrdersJson(vitrine.rushPreset);
            setJsonDraft(exported);
            downloadBakeryFile(
              `vitrine-orders-${vitrine.rushPreset}.json`,
              exported,
            );
            setJsonNotice(
              `Downloaded vitrine-orders-${vitrine.rushPreset}.json (${vitrine.orders.length} orders).`,
            );
          }}
        >
          Download .json
        </button>
        <button
          type="button"
          aria-label="Upload customer order schedule JSON button"
          title="Upload customer order schedule from a .json file"
          onClick={() => fileInputRef.current?.click()}
        >
          Upload .json
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          aria-label="Upload customer order schedule JSON"
          hidden
          onChange={async (e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (!file) return;
            const text = await file.text();
            setJsonDraft(text);
            setJsonPanelOpen(true);
            const res = importCustomVitrineOrdersJson(text);
            if (res.ok) {
              setJsonDraft(exportCustomVitrineOrdersJson(res.preset));
              setJsonNotice(
                `Uploaded ${file.name}: ${res.orderCount} orders (${res.customCount} custom) for ${res.preset}.`,
              );
            } else {
              setJsonNotice(res.error);
            }
          }}
        />
        {props.end}
      </div>
      {jsonPanelOpen && (
        <div
          className="workflow-plan61a-summary"
          aria-label="Customer order schedule JSON panel"
        >
          <label htmlFor={jsonId}>Customer order schedule JSON</label>
          <textarea
            id={jsonId}
            rows={6}
            value={jsonDraft}
            style={{
              width: "100%",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "11px",
              marginTop: "0.35rem",
            }}
            onChange={(e) => setJsonDraft(e.currentTarget.value)}
          />
          <div className="workflow-presets" style={{ marginTop: "0.35rem" }}>
            <button
              type="button"
              onClick={() => {
                const res = importCustomVitrineOrdersJson(jsonDraft);
                if (res.ok) {
                  setJsonDraft(exportCustomVitrineOrdersJson(res.preset));
                  setJsonNotice(
                    `Imported ${res.orderCount} orders (${res.customCount} custom) for ${res.preset}.`,
                  );
                } else {
                  setJsonNotice(res.error);
                }
              }}
            >
              Apply JSON
            </button>
            <button
              type="button"
              onClick={() => {
                setJsonPanelOpen(false);
                setJsonNotice(null);
              }}
            >
              Close JSON
            </button>
          </div>
          {jsonNotice !== null && (
            <p role="status" style={{ marginTop: "0.35rem" }}>
              {jsonNotice}
            </p>
          )}
        </div>
      )}
    </>
  );
}
