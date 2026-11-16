'use strict';
// 서버 동작 점검: 서버를 띄운 뒤(기본 http://localhost:3000) `npm test`
// 방 생성 → 권한 → 진영·선후픽 선택 → 20단계 진행 → 시간 초과 중단 → 세트 승리 → 다음 세트를 확인합니다. (시간 초과 대기로 약 7초)
const WebSocket = require('ws');
const assert = require('assert');
const BASE = process.env.BASE || 'http://localhost:3000';
const WS = BASE.replace('http', 'ws');
const ORDER = 'Bb Rb Bb Rb Bb Rb Bp Rp Rp Bp Bp Rp Rb Bb Rb Bb Rp Bp Bp Rp'.split(' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const other = t => (t === 'B' ? 'R' : 'B');

function client(room, key) {
  const ws = new WebSocket(`${WS}/ws?room=${room}${key ? '&key=' + key : ''}`);
  const c = { ws, last: null, send: m => ws.send(JSON.stringify(m)) };
  ws.on('message', d => { c.last = JSON.parse(d); });
  return new Promise(res => ws.on('open', () => res(c)));
}
const first = (room, key) => new Promise(res => { const w = new WebSocket(`${WS}/ws?room=${room}${key ? '&key=' + key : ''}`); w.on('message', d => res(JSON.parse(d))); });

(async () => {
  const champs = await (await fetch(BASE + '/api/champions')).json();
  const ids = champs.list.map(c => c.id);
  assert(ids.length > 100, '챔피언 목록');
  assert(champs.list[0].names && champs.list[0].names.ko, '챔피언 이름은 언어별로 제공');
  const bgm = await (await fetch(BASE + '/api/bgm')).json();
  assert(Array.isArray(bgm) && bgm.length > 5 && bgm.every(x => /^[\w-]{11}$/.test(x.id)), '브금 목록');

  const { room, keys } = await (await fetch(BASE + '/api/rooms', { method: 'POST', body: JSON.stringify({ turnSec: 5, nameB: 'A', nameR: 'B' }) })).json();
  const admin = await client(room, keys.admin), cast = await client(room, keys.cast);
  const cap = { B: await client(room, keys.B), R: await client(room, keys.R) }; // 처음 블루/레드 링크를 받은 주장
  await sleep(200);
  const st = () => cast.last.s;
  assert.equal(admin.last.role, 'admin'); assert.equal(cap.B.last.role, 'B'); assert.equal(cast.last.role, 'cast');
  assert(admin.last.keys && !cap.B.last.keys && !cast.last.keys, '키는 진행자에게만');
  assert.equal((await first(room)).t, 'denied', '키 없는 접속(관전)은 거부');
  assert.equal((await first('nope')).t, 'noroom');

  // ── 1세트: 선택권은 무작위 ──
  assert.equal(st().status, 'setup'); assert.equal(st().setup.why, 'random'); assert.equal(st().setup.stage, 1);
  const c0 = st().setup.chooser;
  cap.B.send({ t: 'giveFirst' }); admin.send({ t: 'giveFirst' }); await sleep(100);
  assert.equal(st().setup.chooser, other(c0), '첫 번째 선택권은 진행자만 넘길 수 있음'); assert.equal(st().setup.why, 'host');
  const c1 = st().setup.chooser;
  admin.send({ t: 'start' }); cap[other(c1)].send({ t: 'choose', pick: 'first' }); await sleep(100);
  assert.equal(st().status, 'setup', '선택이 끝나기 전에는 시작 불가'); assert.equal(st().setup.stage, 1, '선택권이 없는 팀은 먼저 고를 수 없음');
  cap[c1].send({ t: 'choose', pick: c1 }); await sleep(100); // 지금 진영 그대로 선택
  assert.equal(st().setup.stage, 2); assert.equal(st().setup.need, 'order', '진영을 골랐으면 상대는 선후픽을 고름');
  cap[other(c1)].send({ t: 'choose', pick: 'B' }); await sleep(100);
  assert.equal(st().status, 'setup', '2단계에서는 남은 항목만 선택 가능');
  cap[other(c1)].send({ t: 'choose', pick: other(c1) === 'B' ? 'first' : 'second' }); await sleep(100); // 블루가 선픽이 되도록
  assert.equal(st().status, 'lobby'); assert.equal(st().first, 'B'); assert.equal(st().setup, null);
  assert.equal(cap.B.last.role, 'B', '진영을 그대로 골랐으니 교체 없음');

  cap.B.send({ t: 'start' }); await sleep(100);
  assert.equal(st().status, 'lobby', '주장은 시작 불가');
  admin.send({ t: 'start' }); await sleep(100);
  assert.equal(st().status, 'live');

  cap.R.send({ t: 'commit', id: ids[0] }); cast.send({ t: 'commit', id: ids[0] }); await sleep(100);
  assert.equal(st().hist.length, 0, '차례가 아닌 팀·방송 화면은 선택 불가');
  cap.B.send({ t: 'sel', id: ids[0] }); await sleep(100);
  assert.equal(cap.R.last.s.sel, ids[0], '고르는 중인 챔피언 공유');
  cap.B.send({ t: 'commit' }); await sleep(100);
  assert.deepEqual(st().hist, [ids[0]]);
  cap.R.send({ t: 'commit', id: ids[0] }); await sleep(100);
  assert.equal(st().hist.length, 1, '중복 선택 불가');
  cap.R.send({ t: 'commit', none: true }); await sleep(100);
  assert.deepEqual(st().hist, [ids[0], ''], '밴 없음');
  cap.B.send({ t: 'commit', id: 'NoSuchChampion' }); await sleep(100);
  assert.equal(st().hist.length, 2, '없는 챔피언 불가');

  // 시간 초과 → 경기 중단
  await sleep(5300);
  assert.equal(st().status, 'stopped', '시간 초과 시 중단'); assert.equal(st().stopBy, 'B');
  cap.B.send({ t: 'commit', id: ids[1] }); cap.B.send({ t: 'resume' }); await sleep(100);
  assert.equal(st().status, 'stopped', '중단 중에는 선택·재개 불가(주장)');
  admin.send({ t: 'resume' }); await sleep(100);
  assert.equal(st().status, 'live'); assert(st().remain > 4000, '재개하면 시간이 다시 채워짐');

  for (let i = 2; i < 20; i++) {
    const c = cap[ORDER[i][0]];
    if (i === 7) c.send({ t: 'commit', none: true }); // 픽 차례에는 '없음' 불가
    c.send({ t: 'commit', id: ids[i] }); await sleep(40);
  }
  await sleep(100);
  assert.equal(st().status, 'done'); assert.equal(st().hist.length, 20);

  // ── 선수 이름, 세트 승리, 스코어 ──
  cap.B.send({ t: 'opts', player: { team: 'B', idx: 0, name: '탑솔러' } });
  cap.B.send({ t: 'opts', player: { team: 'R', idx: 0, name: '남의팀' } });
  cap.B.send({ t: 'opts', score: { B: 2, R: 0 } }); cap.B.send({ t: 'win', team: 'B' }); await sleep(100);
  assert.equal(st().players.B[0], '탑솔러'); assert.equal(st().players.R[0], '', '다른 팀 선수 이름은 못 바꿈');
  assert.deepEqual(st().score, { B: 0, R: 0 }, '스코어·승리 기록은 진행자만');
  assert.equal(st().winsNeeded, 2, '기본은 3판 2선승');
  admin.send({ t: 'opts', fearless: true }); admin.send({ t: 'win', team: 'B' }); await sleep(100);
  assert.deepEqual(st().score, { B: 1, R: 0 }, '승리하면 한 칸');
  assert.equal(st().setNo, 2); assert.equal(st().used.length, 10);

  // ── 2세트: 진 팀(레드)이 먼저 고른다 ──
  assert.equal(st().status, 'setup'); assert.equal(st().setup.chooser, 'R'); assert.equal(st().setup.why, 'loser');
  admin.send({ t: 'win', team: 'B' }); cap.B.send({ t: 'choose', pick: 'first' }); await sleep(100);
  assert.deepEqual(st().score, { B: 1, R: 0 }, '밴픽이 끝나기 전에는 승리 기록 불가'); assert.equal(st().setup.stage, 1, '이긴 팀은 먼저 고를 수 없음');
  cap.R.send({ t: 'choose', pick: 'first' }); await sleep(100); // 진 팀이 선픽을 고름
  assert.equal(st().setup.stage, 2); assert.equal(st().setup.need, 'side'); assert.equal(st().first, 'R');
  cap.B.send({ t: 'choose', pick: 'R' }); await sleep(100); // 이긴 팀이 레드 진영을 고름 → 진영 교체
  assert.equal(st().status, 'lobby');
  assert.equal(cap.B.last.role, 'R', '진영을 바꾸면 주장도 반대편으로'); assert.equal(cap.R.last.role, 'B');
  assert.equal(st().nameB, 'B'); assert.equal(st().players.R[0], '탑솔러'); assert.deepEqual(st().score, { B: 0, R: 1 }, '이름·선수·스코어는 팀을 따라감');
  assert.equal(st().first, 'B', '선픽을 고른 팀이 블루로 왔으니 블루가 선픽');

  // 선후픽만 바꾸면 레드가 먼저 시작
  admin.send({ t: 'flipFirst' }); admin.send({ t: 'start' }); await sleep(100);
  assert.equal(st().first, 'R'); assert.equal(st().status, 'live');
  cap.R.send({ t: 'commit', id: ids[30] }); await sleep(100); // cap.R은 지금 블루 진영 = 후픽
  assert.equal(st().hist.length, 0, '후픽 팀은 첫 차례에 선택 불가');
  cap.B.send({ t: 'commit', id: st().used[0] }); await sleep(100); // cap.B는 지금 레드 진영 = 선픽
  assert.equal(st().hist.length, 0, '피어리스: 이전 세트에 쓴 챔피언은 밴도 불가(잠김)');
  cap.B.send({ t: 'commit', id: ids[40] }); await sleep(100);
  assert.equal(st().hist.length, 1, '선픽 팀이 첫 밴');
  for (let i = 1; i < 6; i++) { cap[ORDER[i][0] === 'B' ? 'B' : 'R'].send({ t: 'commit', id: ids[40 + i] }); await sleep(40); }
  await sleep(100);
  assert.equal(st().hist.length, 6);
  cap.B.send({ t: 'commit', id: st().used[1] }); await sleep(100); // 첫 픽: 선픽 팀(레드 진영)
  assert.equal(st().hist.length, 6, '피어리스: 이전 세트 픽 사용 불가');
  cap.B.send({ t: 'commit', id: ids[60] }); await sleep(100);
  assert.equal(st().hist.length, 7);

  // ── 시리즈 방식과 종료 ──
  admin.send({ t: 'opts', bestOf: 5 }); admin.send({ t: 'opts', score: { B: 0, R: 3 } }); await sleep(100);
  assert.equal(st().winsNeeded, 3); assert.equal(st().seriesWinner, 'R', '5판 3선승에서 3승이면 시리즈 종료');
  admin.send({ t: 'opts', bestOf: 3 }); await sleep(100);
  assert.deepEqual(st().score, { B: 0, R: 2 }, '선승 수를 줄이면 스코어도 맞춰짐');
  admin.send({ t: 'wipe' }); await sleep(100);
  assert.equal(st().status, 'setup'); assert.equal(st().setup.why, 'random'); assert.deepEqual(st().score, { B: 0, R: 0 });
  admin.send({ t: 'random' }); await sleep(100);
  assert.equal(st().status, 'lobby', '진행자는 무작위로 한 번에 정할 수 있음');

  console.log('모든 점검 통과');
  process.exit(0);
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
