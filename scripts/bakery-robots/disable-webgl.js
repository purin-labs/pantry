async function disableWebGL(page) {
  await page.addInitScript(`
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(kind, ...args) {
      if (["webgl", "webgl2", "experimental-webgl"].includes(kind)) return null;
      return original.call(this, kind, ...args);
    };
  `);
}
