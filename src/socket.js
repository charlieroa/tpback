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
      const roomName = `tenant:${tenantId}`;
      socket.join(roomName);
      console.log(`   🏠 [SOCKET] ${socket.id} unido a room: ${roomName}`);
      socket.emit("tenant:joined", { room: roomName });

      // Log de cuantos clientes hay en el room
      const room = io.sockets.adapter.rooms.get(roomName);
      console.log(`   👥 [SOCKET] Clientes en ${roomName}: ${room?.size || 0}`);
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
