const { Cam, fit, proj, facing, rings, rrect, prism, solid, put, mk, poly, open, hull, ringAt, run, rad, tween, tset, tval, tdone, register, disposer } = HL;
const BAY_COUNT = 3;
const BAY_PITCH = 44;
const DOOR_THICKNESS = 5.5;

function block(state, parent, x, y, width, depth, bottom, top, radius) {
  const [ring, inner] = rings(x, y, x + width, y + depth, radius, Math.min(0.6, width / 4, depth / 4));
  const part = solid(parent);
  put(part, prism(state.P, state.front, ring, inner, bottom, top));
  return part;
}
function frontPoint(P, y, z, point) { return P(point.u, y, z + point.v); }
function line(state, parent, points) {
  const projected = [];
  for (const point of points) projected.push(state.P(...point));
  return mk('path', { class: 'nf lo', d: open(projected) }, parent);
}
function financier(state, parent, x, y, z) {
  const foot = rrect(x + 0.8, y + 0.4, x + 15.2, y + 4.6, 1, 5);
  const top = rrect(x, y, x + 16, y + 5, 1.3, 5);
  const crown = rrect(x + 1, y + 0.7, x + 15, y + 4.3, 1, 5);
  put(solid(parent), {
    sil: poly(hull(ringAt(state.P, foot, z).concat(ringAt(state.P, top, z + 2.5), ringAt(state.P, crown, z + 3)))),
    crease: open(ringAt(state.P, run(crown, state.front), z + 3)),
  });
}
function controls(state, parent, z) {
  const face = frontPoint.bind(null, state.P, 58.5, z);
  mk('path', { class: 'nf lo', d: poly(rrect(97,7,114,38,1.5,8).map(face)) }, parent);
  for (const height of [22, 30]) {
    mk('path', { class: 'nf', d: poly(rrect(99,height,112,height+6,0.8,6).map(face)) }, parent);
    mk('path', { class: 'nf lo', d: poly(rrect(100,height+1,111,height+5,0.5,6).map(face)) }, parent);
  }
  mk('path', { class: 'nf', d: poly(rrect(102,14,109,21,3.5,12).map(face)) }, parent);
  mk('path', { class: 'nf lo', d: poly(rrect(103.2,15.2,107.8,19.8,2.3,10).map(face)) }, parent);
  for (const x of [100, 108]) {
    mk('path', { class: 'nf', d: poly(rrect(x,9,x+3.5,12.5,1.7,8).map(face)) }, parent);
  }
}
function chamber(state, parent, z) {
  const opening = rrect(7, 7, 93, 37, 2, 8);
  const aperture = poly(opening.map(frontPoint.bind(null, state.P, 58.2, z)));
  const inside = mk('g', { 'clip-path': `path('${aperture}') view-box` }, parent);
  const back = rrect(9, 9, 91, 35, 1.2, 8);
  mk('path', { class: 'sil', d: poly(back.map(frontPoint.bind(null, state.P, 36, z))) }, inside);
  for (const x of [9, 91]) {
    line(state, inside, [[x,36,z+9], [x,58,z+7]]);
    for (const level of [14, 25]) block(state, inside, x - 1, 36, 2, 22, z + level, z + level + 1.5, 0.5);
  }
  block(state, inside, 12, 38, 76, 19, z + 15, z + 16.5, 1.5);
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 3; column++) financier(state, inside, 15 + column * 27, 41 + row * 8, z + 16.5);
  }
  block(state, inside, 12, 56, 76, 1.5, z + 16.5, z + 18.5, 0.5);
  for (const x of [12, 86.5]) block(state, inside, x, 38, 1.5, 19, z + 16.5, z + 18.5, 0.5);
  mk('path', { class: 'nf', d: aperture }, parent);
  controls(state, parent, z);
}
function doorPoint(P, z, angle, offset, point) {
  const height = 33 - point.v;
  return P(point.u, 59 + height * Math.sin(angle) + offset * Math.cos(angle), z + 5 + height * Math.cos(angle) - offset * Math.sin(angle));
}
function frontVisible(P, angle) {
  const corner = doorPoint(P, 0, angle, 0, { u: 0, v: 0 });
  const right = doorPoint(P, 0, angle, 0, { u: 1, v: 0 });
  const bottom = doorPoint(P, 0, angle, 0, { u: 0, v: 1 });
  return (right[0] - corner[0]) * (bottom[1] - corner[1]) - (right[1] - corner[1]) * (bottom[0] - corner[0]) > 0;
}
function drawDoor(state, bay, degrees) {
  if (bay.last === degrees) return;
  bay.last = degrees;
  const angle = rad(degrees);
  const front = doorPoint.bind(null, state.P, bay.z, angle, DOOR_THICKNESS);
  const back = doorPoint.bind(null, state.P, bay.z, angle, 0);
  const exterior = frontVisible(state.P, angle);
  const visible = exterior ? front : back;
  const glazing = doorPoint.bind(null, state.P, bay.z, angle, exterior ? DOOR_THICKNESS - 0.8 : 0.8);
  if (bay.exterior !== exterior) {
    bay.exterior = exterior;
    bay.parent.insertBefore(bay.handleGroup, exterior ? null : bay.doorGroup);
  }
  put(bay.door, {
    sil: poly(hull(state.outline.map(front).concat(state.outline.map(back)))),
    crease: poly(state.outline.map(visible)) + poly(state.window.map(visible)),
  });
  bay.seal.setAttribute('d', poly(state.seal.map(glazing)));
  bay.liner.setAttribute('d', exterior ? '' : poly(state.liner.map(back)));
  const gripFront = doorPoint.bind(null, state.P, bay.z, angle, DOOR_THICKNESS + 3.4);
  const gripBack = doorPoint.bind(null, state.P, bay.z, angle, DOOR_THICKNESS + 0.9);
  put(bay.handle, {
    sil: poly(hull(state.grip.map(gripFront).concat(state.grip.map(gripBack)))),
    crease: poly(state.grip.map(gripFront)),
  });
}
function tick(state, dt, now) {
  let moving = false;
  for (const bay of state.bays) {
    drawDoor(state, bay, tval(bay.angle, now));
    if (!tdone(bay.angle, now)) moving = true;
  }
  return moving;
}
function activate(state, selected) {
  if (selected === state.active) return;
  state.active = selected;
  const now = performance.now();
  for (let index = 0; index < BAY_COUNT; index++) {
    const bay = state.bays[index];
    tset(bay.angle, index === selected ? state.openAngle : 0, now, 0);
    bay.door.sil.classList.toggle('hi', index === (selected < 0 ? 1 : selected));
  }
  state.read.textContent = selected < 0 ? 'rest' : `oven ${selected + 1} · open`;
  state.loop.wake();
}
function move(state, point) {
  let selected = -1;
  let nearest = Infinity;
  for (let index = 0; index < BAY_COUNT; index++) {
    const center = state.bays[index].hit;
    const dx = point[0] - center[0];
    const distance = Math.abs(point[1] - center[1] - dx * 0.5);
    if (Math.abs(dx) < 63 && distance < 28 && distance < nearest) {
      selected = index;
      nearest = distance;
    }
  }
  activate(state, selected);
  return selected;
}
function leave(state) { activate(state, -1); }
function set(state, value) {
  state.openAngle = value;
  if (state.active >= 0) {
    tset(state.bays[state.active].angle, value, performance.now(), 0);
    state.loop.wake();
  }
}
function clear(svg) { svg.replaceChildren(); }
function mount({ stage, svg, read }, value) {
  const bag = disposer();
  const camera = Cam(45, 0.5, 1.47);
  fit(camera, [[-7,-5,0], [123,94,0], [0,0,147], [116,0,147], [0,58,147]], 200, 160);
  const state = { P: proj(camera), front: facing(camera), bays: [], active: -1, openAngle: value, read, loop: null };
  state.outline = rrect(5, 0, 95, 33, 2.5, 10);
  state.liner = rrect(8, 3, 92, 30, 1.8, 10);
  state.window = rrect(13, 9, 87, 26, 2, 10);
  state.seal = rrect(15, 11, 85, 24, 1.5, 10);
  state.grip = rrect(26, 3, 74, 6, 1.4, 8);
  const group = mk('g', {}, svg);
  for (const x of [4, 105]) {
    for (const y of [5, 46]) block(state, group, x, y, 7, 7, 0, 9, 2);
  }
  block(state, group, -5, -3, 126, 66, 7, 12, 4);
  block(state, group, 0, 0, 116, 58, 12, 147, 4);
  for (let index = 0; index < BAY_COUNT; index++) {
    const z = 13 + index * BAY_PITCH;
    const parent = mk('g', {}, group);
    line(state, parent, [[2,58,z+41], [114,58,z+41], [116,2,z+41]]);
    chamber(state, parent, z);
    for (const x of [13, 81]) block(state, parent, x, 57, 8, 4, z + 3, z + 6, 1);
    const doorGroup = mk('g', {}, parent);
    const door = solid(doorGroup);
    const seal = mk('path', { class: 'nf lo' }, doorGroup);
    const liner = mk('path', { class: 'nf' }, doorGroup);
    const handleGroup = mk('g', {}, parent);
    const handle = solid(handleGroup);
    const bay = { z, parent, doorGroup, handleGroup, door, seal, liner, handle, exterior: null, angle: tween(0), last: null, hit: state.P(52,59,z+22) };
    state.bays.push(bay);
    drawDoor(state, bay, 0);
  }
  state.bays[1].door.sil.classList.add('hi');
  read.textContent = 'rest';
  state.loop = register(stage, tick.bind(null, state));
  bag.add(state.loop.unregister);
  bag.add(studyPointer(stage, { move: move.bind(null, state), leave: leave.bind(null, state) }));
  bag.add(clear.bind(null, svg));
  return { set: set.bind(null, state), destroy: bag.dispose };
}
hairline({ name: 'oven-rack', means: 'Move between three stacked ovens to fold one door down and reveal its baking tray; leave to close the doors.', rules: [1,3,4,6,7,8,9], range: [45,75,85], mount });
