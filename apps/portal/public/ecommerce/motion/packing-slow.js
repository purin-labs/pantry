const { Cam, fit, proj, unproj, facing, rings, rrect, fillet, prism, solid, put, mk, poly, hull, ringAt, open, run, spring, stepS, tween, tset, tval, tdone, reducedMotion, register, disposer } = HL;
const PARCEL_PITCH = 43;
const PARCEL_COUNT = 5;
const CYCLE_TIME = 3.6;
const PLAYBACK_RATE = 2.4;
const PRESS_X = 75.5;
const OUTLET_OPENING = fillet([[4,16], [4,33], [46,33], [46,16]], [0,2,2,0], 8);
function box(state, parent, x, y, width, depth, bottom, top, radius) {
  const [ring, inner] = rings(x, y, x + width, y + depth, radius, Math.min(0.7, width / 4, depth / 4));
  const shape = solid(parent);
  put(shape, prism(state.P, state.front, ring, inner, bottom, top));
  return shape;
}
function frontPoint(P, y, point) { return P(point.u, y, point.v); }
function outletPoint(P, x, point) { return P(x, point[0], point[1]); }
function outletShell(state, parent) {
  // The rounded roof meets straight jambs that terminate at the belt plane.
  const outer = fillet([[-3,16], [-3,40], [53,40], [53,16]], [0,4,4,0], 10);
  const front = outer.map(outletPoint.bind(null, state.P, 16));
  const back = outer.map(outletPoint.bind(null, state.P, -26));
  const aperture = OUTLET_OPENING.map(outletPoint.bind(null, state.P, 16));
  mk('path', {
    class: 'sil',
    'fill-rule': 'evenodd',
    d: poly(hull(back.concat(front))) + poly(aperture),
  }, parent);
  mk('path', { class: 'nf lo', d: open(front) }, parent);
}
function packageLane(state, parent) {
  // Clip emerging boxes; release the clip once the entire box clears the shell.
  const visible = OUTLET_OPENING.map(outletPoint.bind(null, state.P, 16))
    .concat(OUTLET_OPENING.map(outletPoint.bind(null, state.P, 240)));
  state.laneClip = `path('${poly(hull(visible))}') view-box`;
  return mk('g', {}, parent);
}
function inspectionBack(state, parent) {
  box(state, parent, 84, -15, 14, 15, 9, 13, 1.5);
  box(state, parent, 88, -13, 6, 6, 13, 61, 1);
}
function inspectionFront(state, parent) {
  box(state, parent, 84, 50, 14, 15, 9, 13, 1.5);
  box(state, parent, 88, 57, 6, 6, 13, 61, 1);
  box(state, parent, 85, 19, 12, 12, 53, 61, 2);
  box(state, parent, 87, -13, 8, 76, 59, 65, 1.5);
}
function roller(state, parent, x) {
  const ring = rrect(x - 2.3, 10, x + 2.3, 14.6, 2.3, 8);
  mk('path', { class: 'nf lo', d: poly(ring.map(frontPoint.bind(null, state.P, 53.1))) }, parent);
}
function pastry(state, parent, x, y) {
  const foot = rrect(x + 0.7, y + 0.5, x + 10.3, y + 5.5, 1.2, 5);
  const top = rrect(x, y, x + 11, y + 6, 1.5, 5);
  const crown = rrect(x + 1, y + 0.7, x + 10, y + 5.3, 1.2, 5);
  put(solid(parent), {
    sil: poly(hull(ringAt(state.P, foot, 21).concat(ringAt(state.P, top, 24), ringAt(state.P, crown, 24.8)))),
    crease: open(ringAt(state.P, run(crown, state.front), 24.8)),
  });
  const crack = [
    state.P(x + 3, y + 3, 24.8),
    state.P(x + 5, y + 2.7, 24.8),
    state.P(x + 6, y + 3.3, 24.8),
    state.P(x + 8, y + 3, 24.8),
  ];
  mk('path', { class: 'nf lo', d: open(crack) }, parent);
}
function place(state, parent, x, z) {
  const origin = state.P(0, 0, 0);
  const position = state.P(x, 0, z);
  parent.setAttribute('transform', `translate(${position[0] - origin[0]} ${position[1] - origin[1]})`);
}
function lid(state, parent) {
  const group = mk('g', {}, parent);
  const shape = box(state, group, -0.8, 8.2, 32.6, 33.6, 20.6, 28.4, 2.8);
  mk('path', { class: 'nf lo', d: poly(ringAt(state.P, rrect(1.2,10.2,29.8,39.8,1.8,8),28.5)) }, group);
  box(state, group, 12, 8.1, 7, 33.8, 28.4, 28.7, 0.7);
  box(state, group, 12, 41.7, 7, 0.2, 20.6, 28.7, 0.1);
  box(state, group, 11, 21, 9, 8, 28.7, 29, 3);
  return { group, shape };
}
function ease(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}
function press(state, cycle) {
  const seating = 1 - ease((cycle - 0.5) / 0.3);
  const stroke = -(16.8 - 1.2 * seating) * (ease(cycle / 0.5) - ease((cycle - 0.95) / 0.45));
  place(state, state.head, 0, stroke);
  put(state.ram, prism(state.P, state.front, state.ramRing, state.ramInner, 51.6 + stroke, 55));
  state.spare.group.setAttribute('display', cycle < 0.65 || cycle >= 1.4 ? 'inline' : 'none');
  place(state, state.spare.group, PRESS_X, 16.8 + stroke + 4 * (1 - ease((cycle - 1.4) / 0.6)) * (cycle >= 1.4 ? 1 : 0));
}
function tick(state, dt, now) {
  const changingSpeed = stepS(state.rate, dt);
  if (state.inspection.kind === 'moving' && !reducedMotion()) state.phase = (state.phase + dt * PLAYBACK_RATE * state.rate.x) % (CYCLE_TIME * PARCEL_COUNT);
  const cycle = state.phase % CYCLE_TIME;
  const travel = PARCEL_PITCH * (Math.floor(state.phase / CYCLE_TIME) + ease((cycle - 1.4) / 2.2));
  press(state, cycle);
  let selected = null;
  const hovered = state.inspection.kind === 'open' ? state.inspection.parcel : null;
  let opening = false;
  let distance = Infinity;
  for (let index = 0; index < state.parcels.length; index++) {
    const parcel = state.parcels[index];
    const x = (index * PARCEL_PITCH + travel) % (PARCEL_PITCH * PARCEL_COUNT) - 53.5;
    const lane = x > 109 ? state.outgoingLane : state.incomingLane;
    // Cleared boxes paint over the press; entering or wrapped boxes lead their layer.
    if (parcel.clip.parentNode !== lane || x < parcel.x) lane.prepend(parcel.clip);
    parcel.x = x;
    parcel.clip.setAttribute('clip-path', x < 16 ? state.laneClip : 'none');
    place(state, parcel.parent, x, 0);
    parcel.parent.setAttribute('display', x > 166 ? 'none' : 'inline');
    parcel.closed = x > PRESS_X + 0.001 || (Math.abs(x - PRESS_X) <= 0.001 && cycle >= 0.65);
    parcel.lid.group.setAttribute('display', parcel.closed ? 'inline' : 'none');
    tset(parcel.lift, parcel === hovered ? 14 : 0, now, 0);
    place(state, parcel.lid.group, 0, tval(parcel.lift, now));
    if (!tdone(parcel.lift, now)) opening = true;
    const fromGate = Math.abs(x - PRESS_X);
    if (fromGate < distance) {
      distance = fromGate;
      selected = parcel;
    }
  }
  if (state.inspection.kind === 'closing' && !opening) state.inspection = { kind: 'moving' };
  if (hovered !== null) selected = hovered;
  state.read.textContent = state.point === null ? 'rest' : 'lid press · 6';
  if (hovered !== null) state.read.textContent = 'peek · 6';
  for (const parcel of state.parcels) {
    parcel.body.sil.classList.toggle('hi', parcel === selected && !parcel.closed);
    parcel.lid.shape.sil.classList.toggle('hi', parcel === selected && parcel.closed);
  }
  return !reducedMotion() || changingSpeed || opening;
}
function move(state, point) {
  state.point = unproj(state.camera, point[0], point[1], 29);
  let selected = null;
  for (const parcel of state.parcels) {
    if (!parcel.closed || parcel.x <= 109 || parcel.x >= 126) continue;
    for (const height of [29, 29 + tval(parcel.lift, performance.now())]) {
      const world = unproj(state.camera, point[0], point[1], height);
      if (world[0] >= parcel.x - 1 && world[0] <= parcel.x + 32 && world[1] >= 8 && world[1] <= 42) selected = parcel;
    }
  }
  if (selected !== null) state.inspection = { kind: 'open', parcel: selected };
  else if (state.inspection.kind === 'open') state.inspection = { kind: 'closing' };
  state.rate.t = state.slowRate;
  state.loop.wake();
  return selected;
}
function leave(state) {
  state.point = null;
  if (state.inspection.kind === 'open') state.inspection = { kind: 'closing' };
  state.rate.t = 1;
  state.loop.wake();
}
function set(state, value) {
  state.slowRate = value;
  if (state.rate.t !== 1) state.rate.t = value;
  state.loop.wake();
}
function clear(svg) { svg.replaceChildren(); }
function mount({ stage, svg, read }, value) {
  const bag = disposer();
  const camera = Cam(45, 0.5, 1.5);
  fit(camera, [[-27,-15,0], [208,65,0], [-27,65,0], [208,-15,65]], 200, 176);
  const state = { camera, P: proj(camera), front: facing(camera), rate: spring(1), slowRate: value, phase: 0, inspection: { kind: 'moving' }, point: null, parcels: [], read, loop: null };
  const group = mk('g', {}, svg);
  box(state, group, 8, 6, 7, 37, 0, 12, 2);
  box(state, group, 167, 6, 7, 37, 0, 12, 2);
  inspectionBack(state, group);
  box(state, group, -26, -3, 234, 56, 9, 16, 8);
  for (let x = 20; x < 165; x += 18) roller(state, group, x);
  box(state, group, 16, -1, 150, 1.6, 16, 17.5, 0.6);
  outletShell(state, group);
  state.incomingLane = packageLane(state, group);
  for (let index = 0; index < PARCEL_COUNT; index++) {
    const clip = mk('g', {}, state.incomingLane);
    const parent = mk('g', {}, clip);
    const body = box(state, parent, 0, 9, 31, 32, 16, 21, 2.6);
    box(state, parent, 1.5, 10.5, 28, 29, 20.5, 20.9, 1.5);
    box(state, parent, 0, 9, 31, 1, 21, 25.2, 0.4);
    box(state, parent, 0, 10, 1, 30, 21, 25.2, 0.4);
    box(state, parent, 15, 11, 1, 28, 21, 22.5, 0.4);
    for (const y of [20, 30]) box(state, parent, 2, y, 27, 1, 21, 22.5, 0.4);
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 2; column++) pastry(state, parent, 3 + column * 14, 12 + row * 10);
    }
    box(state, parent, 0, 40, 31, 1, 21, 25.2, 0.4);
    box(state, parent, 30, 10, 1, 30, 21, 25.2, 0.4);
    state.parcels.push({ clip, parent, body, lid: lid(state, parent), lift: tween(0, 240), closed: false, x: index * PARCEL_PITCH - 53.5 });
  }
  state.spare = lid(state, group);
  state.head = mk('g', {}, group);
  box(state, state.head, PRESS_X - 1.5, 7.5, 34, 35, 45.8, 50.1, 2);
  box(state, state.head, 87, 21, 8, 8, 50.1, 51.6, 1.5);
  state.ram = solid(group);
  [state.ramRing, state.ramInner] = rings(88, 22, 94, 28, 1.5, 0.4);
  state.outgoingLane = mk('g', {}, group);
  box(state, group, 166, -3, 42, 56, 16, 32, 4);
  box(state, group, 16, 50, 150, 1.6, 16, 17.5, 0.6);
  inspectionFront(state, group);
  read.textContent = 'rest';
  state.loop = register(stage, tick.bind(null, state));
  bag.add(state.loop.unregister);
  bag.add(studyPointer(stage, { move: move.bind(null, state), leave: leave.bind(null, state) }));
  bag.add(clear.bind(null, svg));
  tick(state, 0, performance.now());
  return { set: set.bind(null, state), destroy: bag.dispose };
}
hairline({ name: 'packing-slow', means: 'A lid press finishes boxes of six financiers. Hover or tap a finished box to pause and inspect it.', rules: [1,4,6,7,8,9], range: [0.06,0.15,0.35], mount });
