const { Cam, fit, proj, facing, unproj, rings, rrect, circ, prism, solid, put, mk, poly, hull, ringAt, run, open, spring, stepS, register, disposer, clamp } = HL;
const SIZE = 3;
const TRAY_WIDTH = 49;
const TRAY_DEPTH = 43;
const TRAY_GAP = 4;
const REST_HEIGHT = 3;
const GRID_WIDTH = SIZE * TRAY_WIDTH + (SIZE - 1) * TRAY_GAP;
const GRID_DEPTH = SIZE * TRAY_DEPTH + (SIZE - 1) * TRAY_GAP;
const TRAY_LIFT = 7;
const FINANCIER_LIFT = 18;

function block(state, parent, x, y, width, depth, bottom, top, radius) {
  const [ring, inner] = rings(x, y, x + width, y + depth, radius, 0.7);
  put(solid(parent), prism(state.P, state.front, ring, inner, bottom, top));
}
function pinPoint(P, x, point) { return P(x, -24 + point.u, 7 + point.v); }
function pinPart(state, parent, start, end, radius) {
  const ring = circ(radius, 28);
  const back = ring.map(pinPoint.bind(null, state.P, start));
  const front = ring.map(pinPoint.bind(null, state.P, end));
  put(solid(parent), {
    sil: poly(hull(back.concat(front))),
    crease: poly(circ(radius * 0.82, 28).map(pinPoint.bind(null, state.P, end))),
  });
}
function bench(state, parent) {
  block(state, parent, -3, -33, 6, 6, -62, 0, 2);
  block(state, parent, GRID_WIDTH - 3, -33, 6, 6, -62, 0, 2);
  for (const x of [-3, GRID_WIDTH - 3]) block(state, parent, x, GRID_DEPTH - 3, 6, 6, -62, 0, 2);
  block(state, parent, -8, -40, GRID_WIDTH + 16, GRID_DEPTH + 48, -2, 2, 4);
  block(state, parent, 15, -30, 38, 22, 2.2, 3, 1.8);
  block(state, parent, 14, -35, 40, 8, 2, 8, 3);
  for (const x of [20, 48]) {
    const rivet = rrect(x - 0.8, -31.8, x + 0.8, -30.2, 0.8, 8);
    mk('path', { class: 'nf lo', d: poly(ringAt(state.P, rivet, 8.1)) }, parent);
  }
  pinPart(state, parent, 72, 84, 2.2);
  pinPart(state, parent, 84, 132, 5);
  pinPart(state, parent, 132, 144, 2.2);
}
function coolingRack(state, parent, x, y) {
  const group = mk('g', {}, parent);
  let wires = poly(ringAt(state.P, rrect(x + 2, y + 2, x + TRAY_WIDTH - 2, y + TRAY_DEPTH - 2, 2, 6), 2.6));
  for (let u = 5; u < TRAY_WIDTH - 3; u += 5) {
    wires += open([state.P(x + u, y + 3, 2.6), state.P(x + u, y + TRAY_DEPTH - 3, 2.6)]);
  }
  for (let v = 5; v < TRAY_DEPTH - 3; v += 5) {
    wires += open([state.P(x + 3, y + v, 2.6), state.P(x + TRAY_WIDTH - 3, y + v, 2.6)]);
  }
  mk('path', { class: 'nf lo', d: wires }, group);
  return group;
}
function financier(parent, x, y) {
  return {
    x: x + 6.5,
    y: y + 3.5,
    lift: spring(0),
    last: null,
    shape: solid(parent),
    split: mk('path', { class: 'nf lo' }, parent),
    splitPoints: [[x + 3, y + 3.4], [x + 4.6, y + 3.1], [x + 6, y + 3.8], [x + 7.5, y + 3.3], [x + 9.8, y + 3.5]],
    foot: rrect(x + 1, y + 0.8, x + 12, y + 6.2, 1.4, 5),
    top: rrect(x, y, x + 13, y + 7, 1.6, 5),
    crown: rrect(x + 1.2, y + 1.1, x + 11.8, y + 5.9, 1.4, 5),
  };
}
function draw(state, tray) {
  const height = tray.height.x;
  if (tray.last !== height) {
    tray.last = height;
    put(tray.shape, prism(state.P, state.front, tray.ring, tray.inner, height, height + 2));
    const lift = state.P(0, 0, height)[1] - state.P(0, 0, 0)[1];
    tray.wire.setAttribute('transform', `translate(0 ${lift})`);
  }
  for (const cake of tray.cakes) {
    const cakeHeight = height + cake.lift.x;
    if (cake.last === cakeHeight) continue;
    cake.last = cakeHeight;
    const foot = ringAt(state.P, cake.foot, cakeHeight + 2.8);
    const top = ringAt(state.P, cake.top, cakeHeight + 5);
    const crown = ringAt(state.P, cake.crown, cakeHeight + 5.8);
    put(cake.shape, {
      sil: poly(hull(foot.concat(top, crown))),
      crease: open(ringAt(state.P, run(cake.crown, state.front), cakeHeight + 5.8)),
    });
    const split = [];
    for (const point of cake.splitPoints) split.push(state.P(point[0], point[1], cakeHeight + 5.9));
    cake.split.setAttribute('d', open(split));
  }
}
function tick(state, dt) {
  let moving = false;
  for (const tray of state.trays) {
    if (stepS(tray.height, dt)) moving = true;
    for (const cake of tray.cakes) {
      if (stepS(cake.lift, dt)) moving = true;
    }
    draw(state, tray);
  }
  return moving;
}
function distanceLift(state, x, y, maximum) {
  if (state.over === null) return 0;
  const distance = Math.hypot(x - state.over[0], y - state.over[1]);
  return maximum * Math.exp(-Math.pow(distance / state.radius, 2));
}
function retarget(state) {
  let nearestNumber = 5;
  let distance = Infinity;
  for (const tray of state.trays) {
    if (state.over !== null) {
      const d = Math.hypot(tray.x - state.over[0], tray.y - state.over[1]);
      if (d < distance) {
        distance = d;
        nearestNumber = tray.number;
      }
    }
    tray.height.t = REST_HEIGHT + distanceLift(state, tray.x, tray.y, TRAY_LIFT);
    for (const cake of tray.cakes) {
      cake.lift.t = distanceLift(state, cake.x, cake.y, FINANCIER_LIFT);
    }
  }
  for (const tray of state.trays) tray.shape.sil.classList.toggle('hi', tray.number === nearestNumber);
  state.selected = state.over === null ? null : nearestNumber;
  state.read.textContent = state.over === null ? 'rest' : `tray ${nearestNumber} · 9`;
  state.loop.wake();
}
function move(state, point) {
  let distance = Infinity;
  let over = null;
  // Pick against the common rest plane, never the moving heights.
  const world = unproj(state.camera, point[0], point[1], REST_HEIGHT + 5);
  for (const tray of state.trays) {
    const d = Math.hypot(world[0] - tray.x, world[1] - tray.y);
    if (d < distance) {
      distance = d;
      over = [clamp(world[0], 0, GRID_WIDTH), clamp(world[1], 0, GRID_DEPTH)];
    }
  }
  state.over = distance < 48 ? over : null;
  retarget(state);
  return state.selected;
}
function leave(state) {
  state.over = null;
  retarget(state);
}
function set(state, value) {
  state.radius = value;
  retarget(state);
}
function clear(svg) { svg.replaceChildren(); }
function mount({ stage, svg, read }, value) {
  const bag = disposer();
  const camera = Cam(45, 0.5, 1.15);
  fit(camera, [[-8,-40,35], [GRID_WIDTH + 8,GRID_DEPTH + 8,-62], [GRID_WIDTH + 8,-40,2], [-8,GRID_DEPTH + 8,2]], 200, 162);
  const state = { camera, P: proj(camera), front: facing(camera), trays: [], over: null, radius: value, read, loop: null };
  const group = mk('g', {}, svg);
  bench(state, group);
  // Paint back to front. Each financier adds its own lift above its tray.
  for (let diagonal = 0; diagonal < SIZE * 2 - 1; diagonal++) {
    for (let column = 0; column < SIZE; column++) {
      const row = diagonal - column;
      if (row < 0 || row >= SIZE) continue;
      const x = column * (TRAY_WIDTH + TRAY_GAP);
      const y = row * (TRAY_DEPTH + TRAY_GAP);
      const number = row * SIZE + column + 1;
      const [ring, inner] = rings(x, y, x + TRAY_WIDTH, y + TRAY_DEPTH, 3.4, 1.3);
      const parent = mk('g', {}, group);
      const tray = { number, x: x + TRAY_WIDTH / 2, y: y + TRAY_DEPTH / 2, ring, inner, height: spring(REST_HEIGHT), shape: solid(parent), wire: coolingRack(state, parent, x, y), cakes: [], last: null };
      for (let cakeDiagonal = 0; cakeDiagonal < 5; cakeDiagonal++) {
        for (let cakeColumn = 0; cakeColumn < 3; cakeColumn++) {
          const cakeRow = cakeDiagonal - cakeColumn;
          if (cakeRow < 0 || cakeRow >= 3) continue;
          tray.cakes.push(financier(parent, x + 3 + cakeColumn * 15, y + 5 + cakeRow * 13));
        }
      }
      state.trays.push(tray);
      draw(state, tray);
    }
  }
  state.loop = register(stage, tick.bind(null, state));
  bag.add(state.loop.unregister);
  bag.add(studyPointer(stage, { move: move.bind(null, state), leave: leave.bind(null, state) }));
  bag.add(clear.bind(null, svg));
  retarget(state);
  return { set: set.bind(null, state), destroy: bag.dispose };
}
hairline({ name: 'financier-terrain', means: 'Nine cooling trays on a bakery bench: move across the financiers to lift them in a gentle wave.', rules: [1,3,4,5,6,7,8,9], range: [30,45,62], mount });
