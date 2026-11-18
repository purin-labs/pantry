// The barrier that every multi-cell journey checks on each drive reply
// (Refactor 16 step 3). Each cell computes alone to the shared 64 ms grid. A
// cell with an operation receives no command until it ends. A resting cell
// can receive one at any event of another cell, so it never passes the first
// tick that a cell with an operation has not reported yet.
import assert from "node:assert/strict";

const TICK_MICROSECONDS = 2000;
const GRID_MICROSECONDS = 32 * TICK_MICROSECONDS;

function reportsEvents(cell) {
  return (
    cell.hold !== "settled" &&
    (cell.attempt?.lifecycle === "running" ||
      cell.attempt?.lifecycle === "dispatched")
  );
}

/** Asserts the barrier on the cells of one execution view. */
export function assertSharedBarrier(view) {
  const grid =
    (Math.floor(view.time / GRID_MICROSECONDS) + 1) * GRID_MICROSECONDS;
  for (const cell of view.cells) {
    if (cell.hold === "settled") continue;
    assert.ok(
      cell.boundary >= view.time,
      "factory time never passes an evolving cell",
    );
    assert.ok(
      cell.boundary <= grid,
      "no cell computes past the next point of the shared grid",
    );
    if (cell.attempt !== null && cell.hold !== "unresolved") continue;
    for (const other of view.cells)
      if (other.id !== cell.id && reportsEvents(other))
        assert.ok(
          cell.boundary <= other.boundary + TICK_MICROSECONDS,
          "a resting cell never passes an event another cell may report",
        );
  }
}
