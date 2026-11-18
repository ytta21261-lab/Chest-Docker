// Server catur multiplayer (Node.js + Socket.IO + chess.js)
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const PORT = process.env.PORT || 3000;
// Isi dengan URL Netlify kamu, pisahkan koma jika lebih dari satu.
// Contoh: ALLOWED_ORIGIN=https://catur-saya.netlify.app
const ORIGINS = (process.env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());

const httpServer = http.createServer((req, res) => {
  // /health dipakai UptimeRobot agar server Render tidak tidur
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Chess server OK');
});
const io = new Server(httpServer, { cors: { origin: ORIGINS } });

const rooms = new Map();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newRoom() {
  return {
    game: new Chess(),
    seats: { w: null, b: null },        // { token, socketId }
    result: null,                        // { type, winner?, reason? }
    drawOffer: null,                     // 'w' | 'b'
    rematch: { w: false, b: false },
    lastMove: null,
    touched: Date.now(),
  };
}

function snapshot(room) {
  const g = room.game;
  return {
    fen: g.fen(),
    turn: g.turn(),
    check: g.inCheck(),
    history: g.history(),
    lastMove: room.lastMove,
    legal: room.result ? [] : g.moves({ verbose: true }).map(m => ({ from: m.from, to: m.to })),
    result: room.result,
    drawOffer: room.drawOffer,
    rematch: room.rematch,
    online: { w: !!(room.seats.w && room.seats.w.socketId), b: !!(room.seats.b && room.seats.b.socketId) },
    seated: { w: !!room.seats.w, b: !!room.seats.b },
  };
}

function broadcast(code) {
  const room = rooms.get(code);
  if (room) io.to(code).emit('state', snapshot(room));
}

function checkGameOver(room) {
  const g = room.game;
  if (g.isCheckmate()) {
    room.result = { type: 'checkmate', winner: g.turn() === 'w' ? 'b' : 'w' };
  } else if (g.isDraw()) {
    let reason = 'draw';
    if (g.isStalemate()) reason = 'stalemate';
    else if (g.isThreefoldRepetition()) reason = 'threefold repetition';
    else if (g.isInsufficientMaterial()) reason = 'insufficient material';
    else reason = '50-move rule';
    room.result = { type: 'draw', reason };
  }
}

io.on('connection', (socket) => {
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    return room && socket.data.color ? { room, color: socket.data.color, code: socket.data.code } : null;
  };

  function seat(code, room, color, token) {
    room.seats[color] = { token, socketId: socket.id };
    socket.data.code = code;
    socket.data.color = color;
  }

  socket.on('create', (_, ack) => {
    const code = newCode();
    const room = newRoom();
    rooms.set(code, room);
    const color = Math.random() < 0.5 ? 'w' : 'b';
    const token = crypto.randomUUID();
    seat(code, room, color, token);
    socket.join(code);
    ack && ack({ ok: true, code, color, token });
    broadcast(code);
  });

  socket.on('join', ({ code, token } = {}, ack) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, error: 'Room tidak ditemukan.' });
    room.touched = Date.now();

    let color = null;
    let outToken = token;
    // Reconnect dengan token lama
    for (const c of ['w', 'b']) {
      if (room.seats[c] && token && room.seats[c].token === token) {
        color = c;
        room.seats[c].socketId = socket.id;
      }
    }
    // Ambil kursi kosong
    if (!color) {
      const free = ['w', 'b'].find(c => !room.seats[c]);
      if (free) {
        color = free;
        outToken = crypto.randomUUID();
        seat(code, room, free, outToken);
      }
    }
    if (color) { socket.data.code = code; socket.data.color = color; }
    socket.join(code);
    ack && ack({ ok: true, code, color: color || 'spectator', token: color ? outToken : null });
    broadcast(code);
  });

  socket.on('move', ({ from, to, promotion } = {}) => {
    const c = ctx(); if (!c) return;
    const { room, color, code } = c;
    if (room.result || room.game.turn() !== color) return;
    try {
      const m = room.game.move({ from, to, promotion: promotion || 'q' });
      room.lastMove = { from: m.from, to: m.to };
      room.drawOffer = null;
      room.touched = Date.now();
      checkGameOver(room);
      broadcast(code);
    } catch (_) {
      socket.emit('illegal');
      broadcast(code);
    }
  });

  socket.on('resign', () => {
    const c = ctx(); if (!c || c.room.result) return;
    c.room.result = { type: 'resign', winner: c.color === 'w' ? 'b' : 'w' };
    broadcast(c.code);
  });

  socket.on('offerDraw', () => {
    const c = ctx(); if (!c || c.room.result) return;
    c.room.drawOffer = c.color;
    broadcast(c.code);
  });

  socket.on('answerDraw', (accept) => {
    const c = ctx(); if (!c || c.room.result) return;
    if (c.room.drawOffer && c.room.drawOffer !== c.color) {
      if (accept) c.room.result = { type: 'draw', reason: 'agreement' };
      c.room.drawOffer = null;
      broadcast(c.code);
    }
  });

  socket.on('rematch', () => {
    const c = ctx(); if (!c || !c.room.result) return;
    const { room, code, color } = c;
    room.rematch[color] = true;
    if (room.rematch.w && room.rematch.b) {
      // Tukar warna
      [room.seats.w, room.seats.b] = [room.seats.b, room.seats.w];
      const fresh = newRoom();
      Object.assign(room, { game: fresh.game, result: null, drawOffer: null, rematch: { w: false, b: false }, lastMove: null });
      for (const col of ['w', 'b']) {
        const s = room.seats[col];
        if (s && s.socketId) {
          const sock = io.sockets.sockets.get(s.socketId);
          if (sock) { sock.data.color = col; sock.emit('recolor', { color: col }); }
        }
      }
    }
    broadcast(code);
  });

  socket.on('disconnect', () => {
    const c = ctx(); if (!c) return;
    const s = c.room.seats[c.color];
    if (s && s.socketId === socket.id) s.socketId = null;
    broadcast(c.code);
  });
});

// Bersihkan room yang tidak aktif > 6 jam
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > 6 * 3600 * 1000) rooms.delete(code);
  }
}, 10 * 60 * 1000);

httpServer.listen(PORT, () => console.log('Chess server on :' + PORT));
