/** Full Versus Cypher roster — sprites in ../assets/cyphers/ */
(function () {
  const CYPHERS = [
    { id: 0, name: "Calfire", file: "Calfire.gif" },
    { id: 1, name: "Ohwail", file: "Ohwail.gif" },
    { id: 2, name: "Flexseed", file: "Flexseed.gif" },
    { id: 3, name: "Akitash", file: "Akitash.gif" },
    { id: 4, name: "Ancient One", file: "AncientOne.gif" },
    { id: 5, name: "Aralass", file: "Aralass.gif" },
    { id: 6, name: "Buff", file: "Buff.gif" },
    { id: 7, name: "Chesare", file: "Chesare.gif" },
    { id: 8, name: "Chonk", file: "Chonk.gif" },
    { id: 9, name: "Crescient", file: "Crescient.gif" },
    { id: 10, name: "Dandeleon", file: "Dandeleon.gif" },
    { id: 11, name: "Dioxic", file: "Dioxic.gif" },
    { id: 12, name: "Emberion", file: "Emberion.gif" },
    { id: 13, name: "Espiritu", file: "Espiritu.gif" },
    { id: 14, name: "Ethlectric", file: "Ethlectric.gif" },
    { id: 15, name: "HokkaidoWave", file: "HokkaidoWave.gif" },
    { id: 16, name: "Jawsome", file: "Jawsome.gif" },
    { id: 17, name: "Kamakasu", file: "Kamakasu.gif" },
    { id: 18, name: "Metadash", file: "Metadash.gif" },
    { id: 19, name: "Nyx", file: "Nyx.gif" },
    { id: 20, name: "Octopunch", file: "Octopunch.gif" },
    { id: 21, name: "Oritori", file: "Oritori.gif" },
    { id: 22, name: "Rycelium", file: "Rycelium.gif" },
    { id: 23, name: "Shibachu", file: "Shibachu.gif" },
    { id: 24, name: "Snek", file: "Snek.gif" },
    { id: 25, name: "Somnowing", file: "Somnowing.gif" },
    { id: 26, name: "Velocirock", file: "Velocirock.gif" },
    { id: 27, name: "Voxelion", file: "Voxelion.gif" },
    { id: 28, name: "Xaldin", file: "Xaldin.gif" },
  ];

  function cypherSrc(file) {
    return `../assets/cyphers/${file}`;
  }

  function cypherOf(id) {
    return CYPHERS.find((c) => c.id === id) ?? CYPHERS[0];
  }

  function layoutOf(file) {
    const key = file.replace(/\.gif$/i, "");
    return window.VERSUS_CYPHER_LAYOUTS?.[key] ?? null;
  }

  window.VERSUS_CYPHERS = { CYPHERS, cypherSrc, cypherOf, layoutOf };
})();
