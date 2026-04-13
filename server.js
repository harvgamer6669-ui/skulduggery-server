const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

// ── IN-MEMORY STORE ──────────────────────────────────
const players = {};   // socketId -> { id, username, roomCode, ws }
const rooms   = {};   // roomCode -> { host, guest, state, chat }

function makeId(n){ return crypto.randomBytes(n).toString('hex').slice(0,n); }
function makeRoomCode(){ 
  let code;
  do { code = Math.random().toString(36).slice(2,8).toUpperCase(); }
  while (rooms[code]);
  return code;
}

// ── HTTP SERVER (health check for Railway) ────────────
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('Skulduggery Pleasant Multiplayer Server OK');
});

// ── WEBSOCKET SERVER ──────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

function send(ws, obj){ 
  if(ws && ws.readyState === WebSocket.OPEN) 
    ws.send(JSON.stringify(obj)); 
}
function broadcast(roomCode, obj, exceptId){
  const room = rooms[roomCode];
  if(!room) return;
  [room.host, room.guest].forEach(pid => {
    if(!pid || pid === exceptId) return;
    const p = players[pid];
    if(p) send(p.ws, obj);
  });
}
function broadcastAll(roomCode, obj){
  broadcast(roomCode, obj, null);
  const room = rooms[roomCode];
  if(!room) return;
  [room.host, room.guest].forEach(pid => {
    if(!pid) return;
    const p = players[pid];
    if(p) send(p.ws, obj);
  });
}

wss.on('connection', (ws) => {
  const id = makeId(8);
  players[id] = { id, username:'Unknown', roomCode:null, ws };
  send(ws, { type:'connected', id });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e){ return; }
    const player = players[id];
    if(!player) return;

    switch(msg.type){

      // ── SET USERNAME ──────────────────────────────
      case 'setUsername':{
        const name = String(msg.username||'').slice(0,20).trim() || 'Unnamed';
        player.username = name;
        send(ws, { type:'usernameSet', username:name, id });
        break;
      }

      // ── CREATE ROOM ───────────────────────────────
      case 'createRoom':{
        const code = makeRoomCode();
        rooms[code] = { host:id, guest:null, state:null, chat:[] };
        player.roomCode = code;
        send(ws, { type:'roomCreated', roomCode:code, username:player.username });
        console.log(`Room ${code} created by ${player.username}`);
        break;
      }

      // ── JOIN ROOM ─────────────────────────────────
      case 'joinRoom':{
        const code = String(msg.roomCode||'').toUpperCase().trim();
        const room = rooms[code];
        if(!room){ send(ws,{type:'error',msg:'Room not found. Check the code and try again.'}); break; }
        if(room.guest){ send(ws,{type:'error',msg:'Room is full — already has 2 players.'}); break; }
        if(room.host===id){ send(ws,{type:'error',msg:'You created this room!'}); break; }

        room.guest = id;
        player.roomCode = code;

        const hostPlayer = players[room.host];
        send(ws, { type:'roomJoined', roomCode:code, 
          hostName: hostPlayer ? hostPlayer.username : '?' });
        send(hostPlayer.ws, { type:'guestJoined', 
          guestName: player.username, guestId: id });
        console.log(`${player.username} joined room ${code}`);
        break;
      }

      // ── LEAVE ROOM ────────────────────────────────
      case 'leaveRoom':{
        handleLeave(id);
        break;
      }

      // ── GAME STATE SYNC ───────────────────────────
      // Host sends their player state, server forwards to guest & vice-versa
      case 'playerState':{
        const room = rooms[player.roomCode];
        if(!room) break;
        broadcast(player.roomCode, {
          type:'remotePlayerState',
          state: msg.state,
          senderId: id
        }, id);
        break;
      }

      // ── ENEMY SYNC (host is authoritative for enemies) ──
      case 'enemyState':{
        const room = rooms[player.roomCode];
        if(!room || room.host !== id) break; // only host sends enemy state
        broadcast(player.roomCode, {
          type:'remoteEnemyState',
          enemies: msg.enemies
        }, id);
        break;
      }

      // ── WAVE / GAME EVENTS ────────────────────────
      case 'gameEvent':{
        const room = rooms[player.roomCode];
        if(!room) break;
        broadcast(player.roomCode, {
          type:'remoteGameEvent',
          event: msg.event,
          data: msg.data,
          senderId: id
        }, id);
        break;
      }

      // ── CHAT ──────────────────────────────────────
      case 'chat':{
        const room = rooms[player.roomCode];
        if(!room) break;
        const entry = { from: player.username, msg: String(msg.msg||'').slice(0,120), ts: Date.now() };
        room.chat.push(entry);
        if(room.chat.length > 50) room.chat.shift();
        broadcastAll(player.roomCode, { type:'chatMessage', ...entry });
        break;
      }

      // ── PING ──────────────────────────────────────
      case 'ping':
        send(ws, { type:'pong', ts: Date.now() });
        break;
    }
  });

  ws.on('close', () => {
    handleLeave(id);
    delete players[id];
  });

  ws.on('error', () => {
    handleLeave(id);
    delete players[id];
  });
});

function handleLeave(id){
  const player = players[id];
  if(!player || !player.roomCode) return;
  const code = player.roomCode;
  const room = rooms[code];
  if(!room) return;

  broadcast(code, { type:'playerLeft', username: player.username }, id);

  if(room.host === id){
    // Host left — promote guest or close room
    if(room.guest){
      room.host = room.guest;
      room.guest = null;
      const newHost = players[room.host];
      if(newHost){ 
        send(newHost.ws, { type:'promoted', msg:'You are now the host' });
        newHost.roomCode = code;
      }
    } else {
      delete rooms[code];
      console.log(`Room ${code} closed`);
    }
  } else if(room.guest === id){
    room.guest = null;
  }
  player.roomCode = null;
}

// ── START ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Skulduggery Pleasant server running on port ${PORT}`);
});
