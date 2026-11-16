'use strict';
// 예기치 못한 오류가 나도 창이 바로 닫히지 않게 한다 (exe 실행 시)
process.on('uncaughtException', e => {
  console.error('\n[ERROR] ' + (e && e.stack || e));
  if (!process.pkg) process.exit(1);
  console.error('\nCopy the text above, then press Enter to close. / 위 내용을 복사해 두고 Enter를 누르면 닫힙니다.');
  process.stdin.resume(); process.stdin.once('data', () => process.exit(1));
});
// 리그 오브 레전드 5대5 실시간 밴픽 서버
// 실행: npm install && npm start   (포트 변경: PORT=8080 npm start)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { NAMES, ROLES, key } = require('./champions');
const BGM_DEFAULT = require('./bgm');


// ── 설정 ─────────────────────────────────────────────────────
// exe(또는 server.js)와 같은 폴더의 config.json. 없으면 기본값으로 만들어 둔다.
//   port       : 접속 포트 (공유기에서 포트포워딩할 TCP 포트)
//   publicHost : 초대 링크에 쓸 주소. 비워 두면 공인 IP를 자동으로 찾는다. DDNS 도메인이 있으면 여기에 적는다.
//   showPublicIp : true면 실행 창에 공인 IP를 그대로 표시한다. 기본은 가림 (화면 공유 중 노출 방지)
//   lang       : 실행 창 안내 언어. 'ko' 또는 'en'. 비워 두면 Windows 언어에 맞춘다 (화면 언어는 브라우저에서 따로 고른다)
//   tunnel     : true면 cloudflared로 포트 개방 없는 임시 주소를 만든다 (cloudflared.exe 필요)
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const CONFIG_PATH = path.join(APP_DIR, 'config.json');
const config = { port: 3000, publicHost: '', showPublicIp: false, tunnel: false, lang: '' };
let configNote = '';
try {
  if (fs.existsSync(CONFIG_PATH)) Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')));
  else if (process.pkg) fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
} catch (e) { configNote = e.message; }
// 실행 창(콘솔) 문구: 한국어 또는 영어
const sysLocale = (() => { try { return Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch (e) { return ''; } })();
const KO = config.lang ? config.lang === 'ko' : /^ko/i.test(process.env.LANG || '') || /^ko/i.test(sysLocale);
const L = (ko, en) => (KO ? ko : en);
const PORT = Number(process.env.PORT) || Number(config.port) || 3000;
// 밴픽 브금 목록: 같은 폴더에 bgm.json이 있으면 그것을, 없으면 내장 목록을 쓴다. 요청 때마다 읽으므로 고치면 바로 반영된다.
const BGM_PATH = path.join(APP_DIR, 'bgm.json');
try { if (process.pkg && !fs.existsSync(BGM_PATH)) fs.writeFileSync(BGM_PATH, JSON.stringify(BGM_DEFAULT, null, 2) + '\n'); } catch (e) {}
function loadBgm() {
  try {
    if (fs.existsSync(BGM_PATH)) {
      const a = JSON.parse(fs.readFileSync(BGM_PATH, 'utf8').replace(/^\uFEFF/, ''));
      if (Array.isArray(a)) return a.filter(x => x && /^[\w-]{11}$/.test(x.id)).slice(0, 300)
        .map(x => ({ g: x.g === 'worlds' ? 'worlds' : 'lck', y: Number(x.y) || 0, t: String(x.t || x.id).slice(0, 80), id: x.id }));
    }
  } catch (e) {}
  return BGM_DEFAULT;
}
let publicBase = ''; // 초대 링크에 쓸 외부 주소 (예: http://203.0.113.5:3000)
const ROOM_TTL = 12 * 60 * 60 * 1000; // 마지막 활동 후 12시간 지나면 방 삭제
const MAX_ROOMS = 300;
const MIN_SEC = 5, MAX_SEC = 180;

// 토너먼트 드래프트 순서: 밴3-픽3-밴2-픽2
// 아래 순서의 'B'는 "선픽 팀"을 뜻한다. 선픽이 레드 진영이면(s.first === 'R') 글자를 뒤집어 읽는다.
const ORDER = 'Bb Rb Bb Rb Bb Rb Bp Rp Rp Bp Bp Rp Rb Bb Rb Bb Rp Bp Bp Rp'.split(' ')
  .map(s => ({ team: s[0], type: s[1] === 'b' ? 'ban' : 'pick' }));
const other = t => (t === 'B' ? 'R' : 'B');
const stepAt = (s, i) => { const o = ORDER[i]; return o && (s.first === 'R' ? { team: other(o.team), type: o.type } : o); };
const coin = () => (Math.random() < 0.5 ? 'B' : 'R');

// ── 챔피언 목록 ──────────────────────────────────────────────
// 각 챔피언: { id, img, roles, names: { ko, en, ja, zh, ru } }. 화면 언어에 맞는 이름은 브라우저가 고른다.
const LOCALES = { ko: 'ko_KR', en: 'en_US', ja: 'ja_JP', zh: 'zh_CN', ru: 'ru_RU' };
let champs = { version: null, list: NAMES.map(n => ({ id: n, img: null, roles: ROLES[key(n)] || '', names: { ko: n } })) };
let champIds = new Set(champs.list.map(c => c.id));

async function loadChampions() {
  const DD = process.env.DDRAGON_URL || 'https://ddragon.leagueoflegends.com'; // 테스트·미러용으로 바꿀 수 있음
  try {
    const get = async url => {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`${url} → ${r.status}`);
      return r.json();
    };
    const version = (await get(`${DD}/api/versions.json`))[0];
    if (version === champs.version) return;
    const langs = Object.keys(LOCALES);
    const results = await Promise.allSettled(langs.map(l => get(`${DD}/cdn/${version}/data/${LOCALES[l]}/champion.json`)));
    const data = {};
    results.forEach((r, i) => { if (r.status === 'fulfilled' && r.value && r.value.data) data[langs[i]] = r.value.data; });
    const base = data.ko || data.en;
    if (!base) throw new Error(results[0].reason ? results[0].reason.message : 'no data');
    const list = Object.values(base).map(c => {
      const names = {};
      for (const l of langs) if (data[l] && data[l][c.id]) names[l] = data[l][c.id].name;
      return { id: c.id, img: c.image.full, roles: ROLES[key(names.ko || '')] || '', names };
    });
    if (list.length < 100) throw new Error('list too short');
    champs = { version, list };
    champIds = new Set(list.map(c => c.id));
    const missing = langs.filter(l => !data[l]);
    console.log(L(`[챔피언] Data Dragon ${version} · ${list.length}명`, `[champions] Data Dragon ${version} · ${list.length} champions`) + (missing.length ? ` (missing: ${missing.join(', ')})` : ''));
  } catch (e) {
    console.warn(L(
      `[챔피언] Data Dragon을 불러오지 못했습니다 (${e.message}). ${champs.version ? '이전 목록을 유지합니다.' : '내장 목록(초상화 없음, 한국어 이름)을 씁니다.'}`,
      `[champions] Could not load Data Dragon (${e.message}). ${champs.version ? 'Keeping the previous list.' : 'Using the built-in list (no portraits, Korean names).'}`));
  }
}

// ── 방 ───────────────────────────────────────────────────────
const rooms = new Map();
const rid = n => crypto.randomBytes(n).toString('base64url');
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const clampSec = v => Math.min(MAX_SEC, Math.max(MIN_SEC, Math.round(Number(v)) || 30));

function createRoom(o = {}) {
  const room = {
    id: rid(5),
    keys: { admin: rid(9), B: rid(9), R: rid(9), cast: rid(9) }, // cast: 방송 화면용 읽기 전용
    clients: new Set(),
    timer: null,
    touched: Date.now(),
    s: {
      hist: [], sel: '', used: [], setNo: 1,
      fearless: !!o.fearless, turnSec: clampSec(o.turnSec),
      nameB: clean(o.nameB, 16), nameR: clean(o.nameR, 16), // 비어 있으면 화면에서 각자 언어의 기본 이름으로 표시
      status: 'setup', // setup(진영·선후픽 정하기) | lobby | live | stopped | done
      first: 'B', // 선픽인 진영
      // 첫 번째 선택권(First Selection, 2026 시즌 도입): 선택권을 가진 chooser 팀이 '진영' 또는 '밴픽 순서' 중
      // 한 가지만 고르고(stage 1), 상대 팀이 나머지를 정한다(stage 2). 1세트는 무작위, 이후는 직전 세트에서 진 팀이 chooser.
      setup: { chooser: coin(), stage: 1, need: '', why: 'random' },
      deadline: 0, stopBy: '',
      players: { B: ['', '', '', '', ''], R: ['', '', '', '', ''] }, // 방송 화면에 표시할 선수 이름 (픽 순서대로)
      score: { B: 0, R: 0 }, // 시리즈 세트 스코어
      winsNeeded: Number(o.bestOf) === 5 ? 3 : 2, // 3판 2선승(2) 또는 5판 3선승(3)
      seriesWinner: '', // 시리즈가 끝나면 'B' 또는 'R'
    },
  };
  rooms.set(room.id, room);
  return room;
}

function roleOf(room, k) {
  if (k && k === room.keys.admin) return 'admin';
  if (k && k === room.keys.B) return 'B';
  if (k && k === room.keys.R) return 'R';
  if (k && k === room.keys.cast) return 'cast';
  return ''; // 키가 없으면 접속 불가 (관전은 화면 공유로만)
}

function broadcast(room) {
  room.touched = Date.now();
  const s = room.s;
  const online = { B: false, R: false, admin: false, cast: 0 };
  for (const c of room.clients) { if (c.role === 'cast') online.cast++; else online[c.role] = true; }
  const state = { ...s, remain: s.status === 'live' ? Math.max(0, s.deadline - Date.now()) : 0 };
  for (const c of room.clients) {
    if (c.readyState !== 1) continue;
    const msg = { t: 'state', s: state, role: c.role, online };
    if (c.role === 'admin') { msg.keys = room.keys; msg.base = publicBase; }
    c.send(JSON.stringify(msg));
  }
}

function disarm(room) { clearTimeout(room.timer); room.timer = null; room.s.deadline = 0; }
function arm(room) {
  clearTimeout(room.timer);
  const s = room.s;
  s.deadline = Date.now() + s.turnSec * 1000;
  room.timer = setTimeout(() => {
    if (s.status !== 'live' || s.hist.length >= ORDER.length) return;
    // 제한 시간 초과: 자동 선택 없이 경기 중단
    s.status = 'stopped'; s.stopBy = stepAt(s, s.hist.length).team; s.sel = ''; s.deadline = 0;
    broadcast(room);
  }, s.turnSec * 1000);
}

const available = (s, id) => champIds.has(id) && !s.hist.includes(id) && !(s.fearless && s.used.includes(id));

// 진영 교체: 팀 이름·선수·스코어·주장 링크·선픽 여부·선택권이 모두 팀을 따라 반대편으로 이동
function swapSides(room) {
  const s = room.s;
  [s.nameB, s.nameR] = [s.nameR, s.nameB];
  s.players = { B: s.players.R, R: s.players.B };
  s.score = { B: s.score.R, R: s.score.B };
  s.seriesWinner = s.seriesWinner ? other(s.seriesWinner) : '';
  s.first = other(s.first);
  if (s.setup) s.setup.chooser = other(s.setup.chooser);
  [room.keys.B, room.keys.R] = [room.keys.R, room.keys.B];
  for (const c of room.clients) c.role = c.role === 'B' ? 'R' : c.role === 'R' ? 'B' : c.role;
}

function handle(room, role, m) {
  const s = room.s, admin = role === 'admin';
  const step = stepAt(s, s.hist.length);
  const myTurn = s.status === 'live' && step && (admin || role === step.team);

  switch (m.t) {
    case 'sel': { // 고르는 중인 챔피언(모두에게 미리 보임)
      if (!myTurn) return;
      const id = clean(m.id, 40);
      if (id && !available(s, id)) return;
      s.sel = id;
      break;
    }
    case 'commit': { // 확정. none:true면 밴 없음
      if (!myTurn) return;
      let id = '';
      if (m.none) { if (step.type !== 'ban') return; }
      else { id = clean(m.id, 40) || s.sel; if (!id || !available(s, id)) return; }
      s.hist.push(id); s.sel = '';
      if (s.hist.length >= ORDER.length) { s.status = 'done'; disarm(room); } else arm(room);
      break;
    }
    case 'start':
      if (!admin || s.status !== 'lobby') return;
      s.status = 'live'; s.stopBy = ''; arm(room);
      break;
    case 'resume':
      if (!admin || s.status !== 'stopped') return;
      s.status = 'live'; s.stopBy = ''; arm(room);
      break;
    case 'undo':
      if (!admin || !s.hist.length) return;
      s.hist.pop(); s.sel = ''; s.status = 'live'; s.stopBy = ''; arm(room);
      break;
    case 'restart': // 이번 세트 다시 (정해 둔 진영·선후픽은 유지)
      if (!admin) return;
      s.hist = []; s.sel = ''; s.status = s.setup ? 'setup' : 'lobby'; s.stopBy = ''; disarm(room);
      break;
    case 'choose': { // 진영 또는 선후픽 선택. pick: 'B' | 'R' | 'first' | 'second'
      const st = s.setup;
      if (s.status !== 'setup' || !st) return;
      const actor = st.stage === 1 ? st.chooser : other(st.chooser);
      if (!admin && role !== actor) return;
      const kind = m.pick === 'B' || m.pick === 'R' ? 'side' : m.pick === 'first' || m.pick === 'second' ? 'order' : '';
      if (!kind || (st.stage === 2 && kind !== st.need)) return;
      if (kind === 'side') { if (m.pick !== actor) swapSides(room); }
      else s.first = m.pick === 'first' ? actor : other(actor);
      if (st.stage === 1) { st.stage = 2; st.need = kind === 'side' ? 'order' : 'side'; }
      else { s.setup = null; s.status = 'lobby'; }
      break;
    }
    case 'giveFirst': // 진행자: 첫 번째 선택권을 상대 팀에게 넘김 (가위바위보 등으로 따로 정했을 때)
      if (!admin || s.status !== 'setup' || !s.setup || s.setup.stage !== 1) return;
      s.setup.chooser = other(s.setup.chooser); s.setup.why = 'host';
      break;
    case 'random': // 진행자: 진영과 선후픽을 모두 무작위로
      if (!admin || s.status !== 'setup') return;
      if (coin() === 'R') swapSides(room);
      s.first = coin(); s.setup = null; s.status = 'lobby';
      break;
    case 'flipFirst': // 진행자: 선후픽만 맞바꿈
      if (!admin || s.status === 'live' || s.hist.length) return;
      s.first = other(s.first);
      break;
    case 'win': { // 세트 승리 팀 기록 → 스코어 +1, 시리즈가 안 끝났으면 다음 세트로
      const t = m.team;
      if (!admin || s.status !== 'done' || s.seriesWinner || (t !== 'B' && t !== 'R')) return;
      s.score[t] = Math.min(s.winsNeeded, s.score[t] + 1);
      if (s.score[t] >= s.winsNeeded) { s.seriesWinner = t; break; } // 마지막 세트 밴픽은 화면에 남겨 둔다
      ORDER.forEach((o, i) => { const id = s.hist[i]; if (o.type === 'pick' && id && !s.used.includes(id)) s.used.push(id); });
      s.hist = []; s.sel = ''; s.setNo++; disarm(room);
      s.status = 'setup'; s.setup = { chooser: other(t), stage: 1, need: '', why: 'loser' }; // 진 팀이 먼저 고른다
      break;
    }
    case 'wipe': // 시리즈 전체 초기화
      if (!admin) return;
      s.hist = []; s.sel = ''; s.used = []; s.setNo = 1; s.stopBy = ''; s.score = { B: 0, R: 0 }; s.seriesWinner = ''; disarm(room);
      s.status = 'setup'; s.setup = { chooser: coin(), stage: 1, need: '', why: 'random' };
      break;
    case 'swap': // 진행자: 진영 교체
      if (!admin || s.status === 'live') return;
      swapSides(room);
      break;
    case 'opts': {
      if (m.nameB !== undefined && (admin || role === 'B')) s.nameB = clean(m.nameB, 16);
      if (m.nameR !== undefined && (admin || role === 'R')) s.nameR = clean(m.nameR, 16);
      if (admin && m.fearless !== undefined) s.fearless = !!m.fearless;
      if (admin && m.turnSec !== undefined && s.status !== 'live') s.turnSec = clampSec(m.turnSec);
      if (m.player && (m.player.team === 'B' || m.player.team === 'R') && (admin || role === m.player.team)) {
        const i = Number(m.player.idx);
        if (Number.isInteger(i) && i >= 0 && i < 5) s.players[m.player.team][i] = clean(m.player.name, 12);
      }
      if (admin && (Number(m.bestOf) === 3 || Number(m.bestOf) === 5)) s.winsNeeded = Number(m.bestOf) === 5 ? 3 : 2;
      if (admin && m.score) for (const t of ['B', 'R']) { // 잘못 눌렀을 때 직접 고치는 용도
        const v = Number(m.score[t]);
        if (Number.isInteger(v) && v >= 0) s.score[t] = v;
      }
      for (const t of ['B', 'R']) s.score[t] = Math.min(s.score[t], s.winsNeeded);
      if (s.score.B >= s.winsNeeded && s.score.R >= s.winsNeeded) s.score.R = s.winsNeeded - 1; // 양쪽 다 끝점일 수는 없다
      s.seriesWinner = s.score.B >= s.winsNeeded ? 'B' : s.score.R >= s.winsNeeded ? 'R' : '';
      break;
    }
    default: return;
  }
  broadcast(room);
}

// ── HTTP ─────────────────────────────────────────────────────
const INDEX = path.join(__dirname, 'public', 'index.html');
const sendJson = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(INDEX, (err, buf) => {
      if (err) { res.writeHead(500); return res.end('index.html not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  } else if (req.method === 'GET' && url.pathname === '/api/champions') {
    sendJson(res, 200, champs);
  } else if (req.method === 'GET' && url.pathname === '/api/bgm') {
    sendJson(res, 200, loadBgm());
  } else if (req.method === 'POST' && url.pathname === '/api/rooms') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      if (rooms.size >= MAX_ROOMS) return sendJson(res, 503, { error: 'full' });
      let o = {};
      try { o = JSON.parse(body || '{}'); } catch (e) { return sendJson(res, 400, { error: 'bad' }); }
      const room = createRoom(o);
      sendJson(res, 200, { room: room.id, keys: room.keys });
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

// ── WebSocket ────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });
wss.on('error', () => {}); // 포트 충돌 같은 서버 오류는 아래 listen()에서 처리
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const room = rooms.get(url.searchParams.get('room') || '');
  if (!room) { ws.send(JSON.stringify({ t: 'noroom' })); return ws.close(); }
  ws.role = roleOf(room, url.searchParams.get('key'));
  if (!ws.role) { ws.send(JSON.stringify({ t: 'denied' })); return ws.close(); }
  ws.alive = true;
  ws.budget = 30;
  room.clients.add(ws);
  broadcast(room);

  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', data => {
    if (--ws.budget < 0) return; // 초당 메시지 제한
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (m && typeof m.t === 'string') handle(room, ws.role, m);
  });
  ws.on('close', () => { room.clients.delete(ws); broadcast(room); });
  ws.on('error', () => {});
});

setInterval(() => { for (const ws of wss.clients) ws.budget = 30; }, 1000);
setInterval(() => { // 끊긴 연결 정리
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
}, 30000);
setInterval(() => { // 오래된 방 정리
  const now = Date.now();
  for (const [id, room] of rooms) if (!room.clients.size && now - room.touched > ROOM_TTL) { clearTimeout(room.timer); rooms.delete(id); }
}, 10 * 60 * 1000);
setInterval(loadChampions, 6 * 60 * 60 * 1000); // 새 패치 반영

// ── 실행 ─────────────────────────────────────────────────────
// exe로 실행하면: 서버 시작 → 공인 IP 확인 → 접속 주소 안내 → 브라우저 열기
const { spawn, exec } = require('child_process');
const os = require('os');
const PACKAGED = !!process.pkg;
const WANT_OPEN = !process.env.NO_OPEN && (PACKAGED || process.argv.includes('--open'));
const WANT_TUNNEL = !process.env.NO_TUNNEL && (config.tunnel === true || process.argv.includes('--tunnel'));
const line = '─'.repeat(64);

function openBrowser(url) {
  if (!WANT_OPEN) return;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}
function fatal(msg) {
  console.error(`\n${L('[오류]', '[ERROR]')} ${msg}`);
  if (!PACKAGED) process.exit(1);
  console.error(L('Enter를 누르면 닫힙니다.', 'Press Enter to close.'));
  process.stdin.resume(); process.stdin.once('data', () => process.exit(1));
}

// 공인 IP 확인 (초대 링크와 안내에 사용). 실패하면 빈 문자열
async function findPublicIp() {
  for (const url of ['https://api.ipify.org', 'https://checkip.amazonaws.com', 'https://ifconfig.me/ip']) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const ip = (await r.text()).trim();
      if (r.ok && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch (e) {}
  }
  return '';
}

// (선택) Cloudflare Quick Tunnel: 포트를 열지 않고 접속할 수 있는 임시 https 주소
function startTunnel(port, done) {
  const names = process.platform === 'win32' ? ['cloudflared.exe', 'cloudflared-windows-amd64.exe'] : ['cloudflared'];
  const local = names.map(n => path.join(APP_DIR, n)).find(p => fs.existsSync(p));
  let child, settled = false, buf = '';
  const finish = (url, why) => { if (settled) return; settled = true; done(url, why); };
  try { child = spawn(local || names[0], ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], { windowsHide: true }); }
  catch (e) { return finish(null, 'missing'); }
  const scan = d => {
    if (settled) return;
    buf = (buf + d).slice(-20000);
    const hit = (buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g) || []).find(u => !u.includes('//api.'));
    if (hit) finish(hit);
  };
  child.stdout.on('data', scan); child.stderr.on('data', scan);
  child.on('error', () => finish(null, 'missing'));
  child.on('exit', () => { if (settled) console.log(L('\n[터널] cloudflared가 종료되어 임시 주소가 더 이상 동작하지 않습니다.', '\n[tunnel] cloudflared exited; the temporary address no longer works.')); finish(null, 'exit'); });
  setTimeout(() => finish(null, 'timeout'), 40000);
  const kill = () => { try { child.kill(); } catch (e) {} };
  process.on('exit', kill);
  process.on('SIGINT', () => { kill(); process.exit(0); });
}

async function ready(port) {
  const localUrl = `http://localhost:${port}`;
  const lan = lanAddresses();
  const host = String(config.publicHost || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const ip = host ? '' : await findPublicIp();
  if (host) publicBase = `http://${host}${/:\d+$/.test(host) ? '' : ':' + port}`;
  else if (ip) publicBase = `http://${ip}:${port}`;

  console.log(line);
  console.log(L(' 롤 5대5 밴픽 서버 실행 중  (이 창을 닫으면 서버가 꺼집니다)', ' LoL 5v5 Ban/Pick server is running  (closing this window stops the server)'));
  console.log(line);
  if (configNote) console.log(L(` ※ config.json을 읽지 못해 기본값으로 실행합니다 (${configNote})`, ` ! Could not read config.json, using defaults (${configNote})`));
  console.log(L(` 내 PC에서 접속          ${localUrl}`, ` On this PC              ${localUrl}`));
  for (const a of lan) console.log(L(` 같은 공유기 안에서      http://${a}:${port}`, ` On the same network     http://${a}:${port}`));
  console.log(!publicBase
    ? L(' 외부 주소               공인 IP를 확인하지 못했습니다 (초대 링크가 내부 주소로 만들어집니다)', ' Public address          could not be detected (invite links will use the local address)')
    : config.showPublicIp === true
      ? L(` 외부 주소               ${publicBase}`, ` Public address          ${publicBase}`)
      : L(' 외부 주소               확인됨 (가림) → 방 화면의 "링크 복사" 버튼으로만 전달하세요', ' Public address          detected (hidden) → share it only with the "Copy link" buttons in the room'));
  console.log(line);
  console.log(L(' 외부 접속이 되려면 한 번만 설정하면 됩니다.', ' One-time setup for access from outside:'));
  console.log(L(`  1) 공유기 포트포워딩: 외부 TCP ${port} → ${lan[0] || '이 PC의 내부 IP'} 의 TCP ${port}`, `  1) Router port forwarding: external TCP ${port} → ${lan[0] || 'this PC'} TCP ${port}`));
  console.log(L('  2) Windows 방화벽 창이 뜨면 "액세스 허용"', '  2) If Windows Firewall asks, choose "Allow access"'));
  console.log(L('  포트를 바꾸려면 같은 폴더의 config.json에서 port 값을 고치고 다시 실행하세요.', '  To change the port, edit "port" in config.json next to this program and restart.'));
  console.log(line);

  if (!WANT_TUNNEL) return openBrowser(localUrl);
  console.log(L(' 임시 주소(터널)를 만드는 중입니다...', ' Creating a temporary tunnel address...'));
  startTunnel(port, (url, why) => {
    if (url) {
      publicBase = url;
      console.log(config.showPublicIp === true ? L(` 임시 주소 (포트 개방 불필요)  ${url}`, ` Tunnel address (no port forwarding)  ${url}`) : L(' 임시 주소 (포트 개방 불필요)  만들어짐 → 초대 링크가 이 주소로 복사됩니다', ' Tunnel address (no port forwarding)  ready → invite links will use it'));
      console.log(L(' 이 주소는 프로그램을 켤 때마다 바뀝니다.', ' This address changes every time the program starts.'));
    } else {
      console.log(why === 'missing'
        ? L(' 임시 주소를 만들지 못했습니다: 같은 폴더에 cloudflared.exe가 없습니다.', ' Could not create a tunnel: cloudflared.exe was not found next to this program.')
        : L(' 임시 주소를 만들지 못했습니다. 인터넷 연결을 확인해 주세요.', ' Could not create a tunnel. Check your internet connection.'));
    }
    console.log(line);
    openBrowser(localUrl);
  });
}

function listen(port) {
  server.once('error', e => fatal(e.code === 'EADDRINUSE'
    ? L(`${port}번 포트를 다른 프로그램이 쓰고 있습니다. config.json의 port 값을 바꾸고, 공유기 포트포워딩도 같은 번호로 맞춰 주세요.`, `Port ${port} is already in use. Change "port" in config.json and forward the same port on your router.`)
    : e.message));
  server.listen(port, () => { server.removeAllListeners('error'); server.on('error', () => {}); ready(port); });
}

loadChampions().finally(() => listen(PORT));
