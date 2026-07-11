const { app } = require("electron");

app.whenReady().then(async () => {
  try {
    const sdk = await import("@waku/sdk");
    if (typeof sdk.createLightNode !== "function") {
      throw new Error("@waku/sdk did not expose createLightNode");
    }
    console.log(`electron node ${process.versions.node}`);
    console.log("waku sdk loaded in electron main process");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
