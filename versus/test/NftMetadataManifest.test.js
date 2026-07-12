const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

describe("Cypher NFT metadata publication", function () {
  it("publishes one hash-verified metadata document and animation for every on-chain species", function () {
    const file = path.join(__dirname, "..", "..", "deployments", "ipfs", "cypher-nfts.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(manifest.metadata.root).to.equal("bafybeicbtgrjvljtdjgjua6n6vteayl5micu222mbw5ifessrx63xpuyzy");
    const speciesMetadata = Object.keys(manifest.metadata.files).filter((name) => /^\d+\.json$/.test(name));
    const speciesImages = Object.keys(manifest.images.files).filter((name) => /^\d+\.gif$/.test(name));
    expect(speciesMetadata).to.deep.equal(Array.from({ length: 29 }, (_, id) => `${id}.json`));
    expect(speciesImages).to.deep.equal(Array.from({ length: 29 }, (_, id) => `${id}.gif`));
    for (let id = 0; id < 29; id += 1) {
      const metadata = manifest.metadata.files[`${id}.json`];
      const image = manifest.images.files[`${id}.gif`];
      expect(metadata.name).to.equal(image.name);
      expect(metadata.sha256).to.match(/^[a-f0-9]{64}$/);
      expect(image.sha256).to.match(/^[a-f0-9]{64}$/);
      expect(metadata.verified.bytes).to.equal(metadata.bytes);
      expect(image.verified.bytes).to.equal(image.bytes);
    }
  });
});
