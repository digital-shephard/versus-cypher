const { pathToFileURL } = require("node:url");

function trustedFileUrl(filePath) {
  return pathToFileURL(filePath).href;
}

function sameTrustedDocument(actualUrl, trustedUrl) {
  try {
    const actual = new URL(actualUrl);
    const trusted = new URL(trustedUrl);
    actual.hash = "";
    trusted.hash = "";
    return actual.href === trusted.href;
  } catch (_) {
    return false;
  }
}

function isTrustedIpcEvent(event, trustedUrl) {
  const frame = event?.senderFrame;
  return Boolean(frame && frame.top === frame && sameTrustedDocument(frame.url, trustedUrl));
}

function createTrustedIpcRegistrar(ipcMain, trustedUrl) {
  return (channel, handler) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedIpcEvent(event, trustedUrl)) {
        const error = new Error("Blocked IPC from an untrusted renderer");
        error.code = "UNTRUSTED_RENDERER";
        throw error;
      }
      return handler(event, ...args);
    });
  };
}

function hardenRendererWindow(window, trustedUrl) {
  const { webContents } = window;
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("will-navigate", (event, destination) => {
    if (!sameTrustedDocument(destination, trustedUrl)) event.preventDefault();
  });
  webContents.on("will-attach-webview", (event) => event.preventDefault());
  webContents.session.setPermissionCheckHandler(() => false);
  webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}

module.exports = {
  createTrustedIpcRegistrar,
  hardenRendererWindow,
  isTrustedIpcEvent,
  sameTrustedDocument,
  trustedFileUrl,
};
