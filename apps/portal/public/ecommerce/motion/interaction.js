// Touch selects on release. Scrolling cancels the gesture and preserves page navigation.
function studyPoint(stage, event) {
  const bounds = stage.getBoundingClientRect();
  return [(event.clientX - bounds.left) / bounds.width * 400, (event.clientY - bounds.top) / bounds.height * 320];
}
function studyMove(input, event) {
  if (event.pointerType !== 'mouse') return;
  input.selected = null;
  input.on.move(studyPoint(input.stage, event));
}
function studyLeave(input, event) {
  if (event.pointerType !== 'mouse') return;
  input.selected = null;
  input.on.leave();
}
function studyDown(input, event) {
  if (event.pointerType === 'mouse') return;
  input.gesture = { kind: 'pressed', id: event.pointerId, x: event.clientX, y: event.clientY };
}
function studyCancel(input) {
  input.gesture = { kind: 'idle' };
}
function studyUp(input, event) {
  const gesture = input.gesture;
  studyCancel(input);
  if (gesture.kind !== 'pressed' || gesture.id !== event.pointerId) return;
  if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8) return;
  const selected = input.on.move(studyPoint(input.stage, event));
  if (selected === input.selected) {
    input.selected = null;
    input.on.leave();
  } else {
    input.selected = selected;
  }
}
function studyPointer(stage, on) {
  const input = { stage, on, selected: null, gesture: { kind: 'idle' } };
  const bag = HL.disposer();
  bag.on(stage, 'pointermove', studyMove.bind(null, input));
  bag.on(stage, 'pointerleave', studyLeave.bind(null, input));
  bag.on(stage, 'pointerdown', studyDown.bind(null, input));
  bag.on(stage, 'pointerup', studyUp.bind(null, input));
  bag.on(stage, 'pointercancel', studyCancel.bind(null, input));
  return bag.dispose;
}
