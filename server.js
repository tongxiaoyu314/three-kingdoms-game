// 三国·战和守 —— 三人联机博弈游戏 · 服务器
// 职责：当"裁判"，接收三人暗选、隐藏他人选择、统一揭晓、同步分数。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ---------- 静态文件服务 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const PUBLIC_DIR = __dirname;

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// ---------- 游戏状态 ----------
const rooms = new Map(); // code -> room
const ACT_NAMES = ['战', '和', '守'];

function makeRoom(code, hostName, totalRounds) {
  const players = [0, 1, 2].map((seat) => ({
    seat,
    name: seat === 0 ? hostName : '',
    token: crypto.randomBytes(9).toString('hex'),
    ws: null,
    connected: false,
  }));
  return {
    code,
    hostSeat: 0,
    totalRounds,
    players,
    state: 'lobby', // lobby | choosing | revealed | ended
    round: 0,
    treasure: 0,
    choices: [null, null, null],
    scores: [0, 0, 0],
    history: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    lastReveal: null,
    lastResult: null,
  };
}

function genCode() {
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(code));
  return code;
}

function clampRounds(n) {
  n = Number(n);
  return [6, 9, 12].includes(n) ? n : 9;
}

function send(room, msg) {
  const data = JSON.stringify(msg);
  room.players.forEach((p) => {
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  });
}

function roomInfo(room) {
  return {
    type: 'room',
    code: room.code,
    hostSeat: room.hostSeat,
    totalRounds: room.totalRounds,
    state: room.state,
    round: room.round,
    treasure: room.treasure,
    seats: room.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      connected: p.connected,
      chosen: room.choices[p.seat] !== null,
    })),
  };
}

function snapshotFor(room, seat) {
  return {
    type: 'snapshot',
    code: room.code,
    hostSeat: room.hostSeat,
    totalRounds: room.totalRounds,
    state: room.state,
    round: room.round,
    treasure: room.treasure,
    seats: room.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      connected: p.connected,
      chosen: room.choices[p.seat] !== null,
    })),
    scores: room.scores,
    history: room.history,
    myChoice: room.choices[seat],
    lastReveal: room.lastReveal,
    lastResult: room.lastResult,
  };
}

// ---------- 结算逻辑 ----------
function computeRound(room) {
  const ch = room.choices; // [a,b,c]，0=战 1=和 2=守
  const w = ch.filter((c) => c === 0).length;
  const pCnt = ch.filter((c) => c === 1).length;
  let situation;
  if (w === 0) situation = '🕊️ 和平盛世 · 无人开战';
  else if (w === 1) situation = '⚔️ 独战夺宝 · 一人出击';
  else situation = '💥 ' + (w === 3 ? '三方混战' : '两方混战') + ' · 两败俱伤';

  const deltas = [];
  const descs = [];
  for (let i = 0; i < 3; i++) {
    const c = ch[i];
    if (c === 2) { deltas.push(2); descs.push('守城自稳 +2'); }
    else if (c === 1) {
      if (w === 0) { const d = Math.floor(room.treasure / pCnt); deltas.push(d); descs.push('和平分宝·均分'); }
      else if (w === 1) { deltas.push(-3); descs.push('被独战者抢掠'); }
      else { deltas.push(0); descs.push('混战·躲过一劫'); }
    } else {
      if (w === 1) { deltas.push(room.treasure); descs.push('独战·夺下宝藏'); }
      else { deltas.push(-5); descs.push('混战·两败俱伤'); }
    }
  }
  return { situation, deltas, descs };
}

function beginRound(room) {
  room.treasure = 8 + Math.floor(Math.random() * 8); // 8..15
  room.choices = [null, null, null];
  send(room, {
    type: 'round',
    round: room.round,
    totalRounds: room.totalRounds,
    treasure: room.treasure,
  });
}

function reveal(room) {
  room.state = 'revealed';
  const r = computeRound(room);
  for (let i = 0; i < 3; i++) {
    room.scores[i] += r.deltas[i];
    room.history[i][room.choices[i]]++;
  }
  room.lastReveal = {
    round: room.round,
    treasure: room.treasure,
    situation: r.situation,
    players: room.players.map((p, i) => ({
      seat: i,
      name: p.name,
      action: room.choices[i],
      delta: r.deltas[i],
      desc: r.descs[i],
    })),
    scores: room.scores,
    history: room.history,
    lastRound: room.round >= room.totalRounds,
  };
  send(room, { type: 'reveal', ...room.lastReveal });
}

function endGame(room) {
  room.state = 'ended';
  const order = [0, 1, 2].slice().sort((a, b) => room.scores[b] - room.scores[a]);
  const top = room.scores[order[0]];
  const tied = order.filter((s) => room.scores[s] === top);
  let winner;
  if (tied.length > 1) winner = '🤝 平分秋色 · ' + tied.map((s) => room.players[s].name).join('、');
  else winner = '🏆 ' + room.players[order[0]].name + ' 问鼎天下！';
  room.lastResult = {
    winner,
    scores: room.scores,
    history: room.history,
    order,
    names: room.players.map((p) => p.name),
  };
  send(room, { type: 'result', ...room.lastResult });
}

// ---------- 消息处理 ----------
function onCreate(ws, m) {
  const code = genCode();
  const room = makeRoom(code, String(m.name || '房主').slice(0, 6), clampRounds(m.totalRounds));
  const p = room.players[0];
  p.ws = ws;
  p.connected = true;
  ws.roomCode = code;
  ws.seat = 0;
  rooms.set(code, room);
  ws.send(JSON.stringify({ type: 'joined', code, seat: 0, token: p.token, hostSeat: 0, totalRounds: room.totalRounds }));
  send(room, roomInfo(room));
}

function onJoin(ws, m) {
  const code = String(m.code || '').trim();
  const room = rooms.get(code);
  if (!room) return ws.send(JSON.stringify({ type: 'error', message: '房间不存在，请检查房间码' }));
  if (room.state !== 'lobby') return ws.send(JSON.stringify({ type: 'error', message: '游戏已开始，无法加入' }));
  const empty = room.players.find((p) => !p.connected);
  if (!empty) return ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
  empty.name = String(m.name || '玩家' + (empty.seat + 1)).slice(0, 6);
  empty.ws = ws;
  empty.connected = true;
  ws.roomCode = code;
  ws.seat = empty.seat;
  ws.send(JSON.stringify({ type: 'joined', code, seat: empty.seat, token: empty.token, hostSeat: room.hostSeat, totalRounds: room.totalRounds }));
  send(room, roomInfo(room));
}

function onReconnect(ws, m) {
  const code = String(m.code || '').trim();
  const room = rooms.get(code);
  if (!room) return ws.send(JSON.stringify({ type: 'error', message: '房间已失效，请重新创建' }));
  const seat = Number(m.seat);
  const p = room.players[seat];
  if (!p || p.token !== String(m.token)) return ws.send(JSON.stringify({ type: 'error', message: '身份校验失败' }));
  p.ws = ws;
  p.connected = true;
  ws.roomCode = code;
  ws.seat = seat;
  ws.send(JSON.stringify({ type: 'joined', code, seat, token: p.token, hostSeat: room.hostSeat, totalRounds: room.totalRounds }));
  ws.send(JSON.stringify(snapshotFor(room, seat)));
  send(room, roomInfo(room));
}

function onStart(ws) {
  const room = ws.roomCode && rooms.get(ws.roomCode);
  if (!room || ws.seat !== room.hostSeat) return;
  if (room.state !== 'lobby') return;
  if (room.players.some((p) => !p.connected)) {
    return send(room, { type: 'error', message: '需要 3 名玩家都在线才能开始' });
  }
  room.state = 'choosing';
  room.round = 1;
  beginRound(room);
}

function onChoose(ws, m) {
  const room = ws.roomCode && rooms.get(ws.roomCode);
  if (!room || room.state !== 'choosing') return;
  const a = Number(m.action);
  if (![0, 1, 2].includes(a)) return;
  if (room.choices[ws.seat] !== null) return;
  room.choices[ws.seat] = a;
  send(room, { type: 'submitted', seat: ws.seat });
  if (room.choices.every((c) => c !== null)) reveal(room);
}

function onAdvance(ws) {
  const room = ws.roomCode && rooms.get(ws.roomCode);
  if (!room || room.state !== 'revealed') return;
  if (room.round >= room.totalRounds) { endGame(room); return; }
  room.round++;
  room.state = 'choosing';
  beginRound(room);
}

function onRestart(ws) {
  const room = ws.roomCode && rooms.get(ws.roomCode);
  if (!room || ws.seat !== room.hostSeat) return;
  room.state = 'lobby';
  room.round = 0;
  room.treasure = 0;
  room.choices = [null, null, null];
  room.scores = [0, 0, 0];
  room.history = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  room.lastReveal = null;
  room.lastResult = null;
  send(room, roomInfo(room));
}

function onClose(ws) {
  const room = ws.roomCode && rooms.get(ws.roomCode);
  if (!room) return;
  const p = room.players[ws.seat];
  if (p && p.ws === ws) {
    p.connected = false;
    p.ws = null;
  }
  if (room.state === 'lobby' && room.players.every((x) => !x.connected)) {
    rooms.delete(room.code);
    return;
  }
  send(room, roomInfo(room));
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    switch (m.type) {
      case 'create': onCreate(ws, m); break;
      case 'join': onJoin(ws, m); break;
      case 'reconnect': onReconnect(ws, m); break;
      case 'start': onStart(ws, m); break;
      case 'choose': onChoose(ws, m); break;
      case 'advance': onAdvance(ws, m); break;
      case 'restart': onRestart(ws, m); break;
    }
  });
  ws.on('close', () => onClose(ws));
});

// 心跳保活
setInterval(() => {
  wss.clients.forEach((ws) => { if (ws.readyState === ws.OPEN) ws.ping(); });
}, 30000);

server.listen(PORT, () => {
  console.log('三国·战和守 服务器已启动： http://localhost:' + PORT);
});
