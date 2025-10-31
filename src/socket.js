// src/socket.js
const { Server } = require("socket.io");

let io;

/**
 * Inicializa Socket.IO sobre un servidor HTTP existente.
 * @param {import('http').Server} server
 * @param {string[]} allowedOrigins
 */
function initSocket(server, allowedOrigins = []) {
  io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  io.on("connection", (socket) => {
    console.log("⚡ Cliente conectado:", socket.id);

    // El frontend hace: socket.emit("join:tenant", tenantId)
    socket.on("join:tenant", (tenantId) => {
      if (!tenantId) return;
      socket.join(`tenant:${tenantId}`);
      socket.emit("tenant:joined", { room: `tenant:${tenantId}` });
    });

    socket.on("disconnect", () => {
      console.log("👋 Cliente desconectado:", socket.id);
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error("Socket.IO no inicializado");
  return io;
}

module.exports = { initSocket, getIO };
