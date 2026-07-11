const net = require("net");
const { randomBytes } = require("crypto");
const { EventEmitter } = require("events");

const MESH_PROTOCOL = "versus-mesh";
const MESH_VERSION = 1;

class TcpMeshTransport extends EventEmitter {
  constructor({ maxFrameBytes = 16_384 } = {}) {
    super();
    this.maxFrameBytes = maxFrameBytes;
    this.server = null;
    this.sockets = new Set();
    this.buffers = new WeakMap();
    this.socketState = new WeakMap();
  }

  async listen({ host = "127.0.0.1", port = 0 } = {}) {
    if (this.server) throw new Error("transport is already listening");
    this.server = net.createServer((socket) => this.attach(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, host);
    });
    const address = this.server.address();
    return { host: address.address, port: address.port, url: `tcp://${address.address}:${address.port}` };
  }

  async connect(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "tcp:") throw new TypeError("peer url must use tcp protocol");
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new RangeError("peer url must include a valid port");
    }
    const socket = net.createConnection({ host: parsed.hostname, port });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        socket.off("connect", onConnect);
        reject(error);
      };
      const onConnect = () => {
        socket.off("error", onError);
        resolve();
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
    this.attach(socket);
    return socket;
  }

  attach(socket) {
    if (this.sockets.has(socket)) return;
    socket.setNoDelay(true);
    this.sockets.add(socket);
    this.buffers.set(socket, "");
    const state = {
      localChallenge: `0x${randomBytes(16).toString("hex")}`,
      peerChallenge: null,
    };
    this.socketState.set(socket, state);

    socket.on("data", (chunk) => this.onData(socket, chunk));
    socket.on("error", (error) => this.emit("peerError", error, socket));
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.buffers.delete(socket);
      this.socketState.delete(socket);
      this.emit("peerDisconnect", socket);
    });

    this.writeFrame(socket, {
      protocol: MESH_PROTOCOL,
      version: MESH_VERSION,
      kind: "hello",
      challenge: state.localChallenge,
    });
    this.emit("peerConnect", socket);
  }

  onData(socket, chunk) {
    let buffer = (this.buffers.get(socket) || "") + chunk.toString("utf8");
    if (Buffer.byteLength(buffer, "utf8") > this.maxFrameBytes * 2 && !buffer.includes("\n")) {
      this.emit("peerError", new Error("peer exceeded maximum frame size"), socket);
      socket.destroy();
      return;
    }

    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
        this.emit("peerError", new Error("peer frame is too large"), socket);
        socket.destroy();
        return;
      }
      try {
        const frame = JSON.parse(line);
        if (frame.protocol !== MESH_PROTOCOL || frame.version !== MESH_VERSION) {
          throw new Error("peer used an unsupported mesh protocol");
        }
        if (frame.kind === "hello") {
          if (typeof frame.challenge !== "string" || !/^0x[0-9a-f]{32}$/.test(frame.challenge)) {
            throw new Error("peer sent an invalid connection challenge");
          }
          this.socketState.get(socket).peerChallenge = frame.challenge;
          this.emit("peerHello", frame.challenge, socket);
        } else if (frame.kind === "postcard") {
          this.emit("postcard", frame.postcard, socket, frame.paymentProof || null);
        } else if (frame.kind === "control") {
          this.emit("control", frame.control, frame.data, socket);
        }
      } catch (error) {
        this.emit("peerError", error, socket);
      }
    }

    this.buffers.set(socket, buffer);
  }

  writeFrame(socket, frame) {
    if (socket.destroyed || !socket.writable) return false;
    const encoded = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > this.maxFrameBytes) {
      throw new RangeError("outbound frame is too large");
    }
    socket.write(encoded);
    return true;
  }

  broadcast(postcard, { except = null, paymentProof = null } = {}) {
    let sent = 0;
    const frame = {
      protocol: MESH_PROTOCOL,
      version: MESH_VERSION,
      kind: "postcard",
      postcard,
      paymentProof,
    };
    for (const socket of this.sockets) {
      if (socket === except) continue;
      if (this.writeFrame(socket, frame)) sent += 1;
    }
    return sent;
  }

  sendPostcard(socket, postcard, paymentProof = null) {
    return this.writeFrame(socket, {
      protocol: MESH_PROTOCOL,
      version: MESH_VERSION,
      kind: "postcard",
      postcard,
      paymentProof,
    });
  }

  sendControl(socket, control, data) {
    if (typeof control !== "string" || !/^[a-z_]{1,32}$/.test(control)) {
      throw new TypeError("control name is invalid");
    }
    return this.writeFrame(socket, {
      protocol: MESH_PROTOCOL,
      version: MESH_VERSION,
      kind: "control",
      control,
      data,
    });
  }

  localChallenge(socket) {
    return this.socketState.get(socket)?.localChallenge || null;
  }

  get peerCount() {
    return this.sockets.size;
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

module.exports = { MESH_PROTOCOL, MESH_VERSION, TcpMeshTransport };
