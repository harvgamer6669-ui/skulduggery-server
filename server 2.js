'use strict';
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const players = {};
const rooms   = {};

function makeId(n){ return crypto.randomBytes(n).toString('hex').slice(0,n); }
function makeRoomCode(){
  let code;
  do { code = Math.random().toString(36).slice(2,8).toUpperCase(); }
  while (rooms[code]);
  return code;
}

// HTTP health-check — Railway requires a responding HTTP server
const httpServer = http.createServer(function(req, res){
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('OK');
});

const wss = new WebSocket.Server({ server: httpServer });

function send(ws, obj){
  if(ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(obj));
}
function toRoom(roomCode, obj, exceptId){
  const room = rooms[roomCode];
  if(!room) return;
  [room.host, room.guest].forEach(function(pid){
    if(!pid || pid === exceptId) return;
    const p = players[pid];
    if(p) send(p.ws, obj);
  });
}
function toRoomAll(roomCode, obj){
  const room = rooms[roomCode];
  if(!room) return;
  [room.host, room.guest].forEach(function(pid){
    if(!pid) return;
    const p = players[pid];
    if(p) send(p.ws, obj);
  });
}

wss.on('connection', function(ws){
  const id = makeId(8);
  players[id] = { id:id, username:'Unknown', roomCode:null, ws:ws };
  send(ws, { type:'connected', id:id });
  console.log('Player connected:', id);

  ws.on('message', function(raw){
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e){ return; }
    const player = players[id];
    if(!player) return;

    switch(msg.type){

      case 'setUsername':{
        const name = String(msg.username||'').slice(0,20).trim() || 'Unnamed';
        player.username = name;
        send(ws, { type:'usernameSet', username:name, id:id });
        console.log('Username set:', name);
        break;
      }

      case 'createRoom':{
        const code = makeRoomCode();
        rooms[code] = { host:id, guest:null, chat:[] };
        player.roomCode = code;
        send(ws, { type:'roomCreated', roomCode:code });
        console.log('Room created:', code, 'by', player.username);
        break;
      }

      case 'joinRoom':{
        const code = String(msg.roomCode||'').toUpperCase().trim();
        const room = rooms[code];
        if(!room){ send(ws,{type:'error',msg:'Room not found'}); break; }
        if(room.guest){ send(ws,{type:'error',msg:'Room is full'}); break; }
        if(room.host===id){ send(ws,{type:'error',msg:'You are the host of this room'}); break; }
        room.guest = id;
        player.roomCode = code;
        const host = players[room.host];
        send(ws, { type:'roomJoined', roomCode:code, hostName: host?host.username:'?' });
        if(host) send(host.ws, { type:'guestJoined', guestName:player.username, guestId:id });
        console.log(player.username, 'joined room', code);
        break;
      }

      case 'leaveRoom':{
        handleLeave(id);
        break;
      }

      case 'playerState':{
        const room = rooms[player.roomCode];
        if(!room) break;
        toRoom(player.roomCode, { type:'remotePlayerState', state:msg.state, senderId:id }, id);
        break;
      }

      case 'enemyState':{
        const room = rooms[player.roomCode];
        if(!room || room.host!==id) break;
        toRoom(player.roomCode, { type:'remoteEnemyState', enemies:msg.enemies }, id);
        break;
      }

      case 'gameEvent':{
        const room = rooms[player.roomCode];
        if(!room) break;
        toRoom(player.roomCode, { type:'remoteGameEvent', event:msg.event, data:msg.data, senderId:id }, id);
        break;
      }

      case 'chat':{
        const room = rooms[player.roomCode];
        if(!room) break;
        const text = String(msg.msg||'').slice(0,120).trim();
        if(!text) break;
        const entry = { type:'chatMessage', from:player.username, msg:text };
        room.chat.push(entry);
        if(room.chat.length>50) room.chat.shift();
        toRoomAll(player.roomCode, entry);
        break;
      }

      case 'ping':
        send(ws, { type:'pong', ts:Date.now() });
        break;
    }
  });

  ws.on('close', function(){ handleLeave(id); delete players[id]; });
  ws.on('error', function(e){ console.error('WS error:', e.message); handleLeave(id); delete players[id]; });
});

function handleLeave(id){
  const player = players[id];
  if(!player || !player.roomCode) return;
  const code = player.roomCode;
  const room = rooms[code];
  if(!room){ player.roomCode=null; return; }

  toRoom(code, { type:'playerLeft', username:player.username }, id);

  if(room.host===id){
    if(room.guest){
      room.host = room.guest;
      room.guest = null;
      const newHost = players[room.host];
      if(newHost){ send(newHost.ws, { type:'promoted' }); }
    } else {
      delete rooms[code];
      console.log('Room closed:', code);
    }
  } else {
    room.guest = null;
  }
  player.roomCode = null;
}

const PORT = parseInt(process.env.PORT) || 3000;
httpServer.listen(PORT, '0.0.0.0', function(){
  console.log('Server listening on port', PORT);
});
