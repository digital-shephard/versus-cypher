const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const rendererDir = path.join(__dirname, "..", "renderer");

function loadLayouts() {
  const context = { window: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(rendererDir, "cypher-layouts.js"), "utf8"),
    context
  );
  return context.window.VERSUS_CYPHER_LAYOUTS;
}

test("raft art-direction tuning remains separate from collectible card layout", () => {
  const layouts = loadLayouts();
  assert.equal(layouts.Akitash.raftZoom, 0.875);
  assert.equal(layouts.Akitash.y, 13);
  assert.equal(layouts.Aralass.raftZoom, 1.105);
  assert.equal(layouts.Buff.raftZoom, 0.7);
  assert.equal(layouts.Calfire.raftZoom, 1.25);
  assert.equal(layouts.Ethlectric.raftZoom, 1.15);
  assert.equal(layouts.Kamakasu.raftZoom, 1.495);
  assert.equal(layouts.Nyx.raftZoom, 1.5);
  assert.equal(layouts.Ohwail.raftZoom, 1.3);
  assert.equal(layouts.Shibachu.raftZoom, 1.5);
  assert.equal(layouts.Somnowing.raftZoom, 1.2);
  assert.equal(layouts.Chonk.y, 13);
  assert.equal(layouts.Emberion.x, -7);
  assert.equal(layouts.Xaldin.y, 20);

  for (const name of ["Akitash", "Aralass", "Buff", "Calfire", "Ethlectric", "Kamakasu", "Nyx", "Ohwail", "Shibachu", "Somnowing"]) {
    assert.equal(layouts[name].zoom, undefined);
  }
});

test("raft and graduation geometry consume raftZoom", () => {
  const rendererSource = fs.readFileSync(path.join(rendererDir, "pet.js"), "utf8");
  assert.equal((rendererSource.match(/layout\.raftZoom \|\| 1/g) || []).length, 2);
});
