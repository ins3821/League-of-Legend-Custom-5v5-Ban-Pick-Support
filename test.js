'use strict';
// 서버 동작 점검: 서버를 띄운 뒤(기본 http://localhost:3000) `npm test`
// 방 생성 → 권한 확인 → 20단계 진행 → 시간 초과 시 경기 중단 → 재개를 확인합니다. (시간 초과 대기로 약 6초 걸림)
const WebSocket = require('ws');
const assert = require('assert');
const BASE = process.env.BASE || 'http://localhost:3000';
const ORDER = 'Bb Rb Bb Rb Bb Rb Bp Rp Rp Bp Bp Rp Rb Bb Rb Bb Rp Bp Bp Rp'.split(' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(room, key) {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?room=${room}${key ? '&key=' + key : ''}`);
  const c = { ws, last: null, send: m => ws.send(JSON.stringify(m)) };
  ws.on('message', d => { c.last = JSON.parse(d); });
  return new Promise(res => ws.on('open', () => res(c)));
}

(async () => {
  const champs = await (await fetch(BASE + '/api/champions')).json();
  const ids = champs.list.map(c => c.id);
  assert(ids.length > 100, '챔피언 목록');

  const made = await (await fetch(BASE + '/api/rooms', { method: 'POST', body: JSON.stringify({ turnSec: 5, nameB: 'A', nameR: 'B' }) })).json();
  const { room, keys } = made;
  const admin = await client(room, keys.admin), B = await client(room, keys.B), R = await client(room, keys.R), spec = await client(room, keys.cast);
  await sleep(200);
  assert.equal(admin.last.role, 'admin'); assert.equal(B.last.role, 'B'); assert.equal(spec.last.role, 'cast');
  assert(admin.last.keys && !B.last.keys && !spec.last.keys, '키는 진행자에게만');

  B.send({ t: 'start' }); await sleep(100);
  assert.equal(spec.last.s.status, 'lobby', '주장은 시작 불가');
  admin.send({ t: 'start' }); await sleep(100);
  assert.equal(spec.last.s.status, 'live');

  R.send({ t: 'commit', id: ids[0] }); spec.send({ t: 'commit', id: ids[0] }); await sleep(100);
  assert.equal(spec.last.s.hist.length, 0, '차례가 아닌 팀·관전자는 선택 불가');

  B.send({ t: 'sel', id: ids[0] }); await sleep(100);
  assert.equal(R.last.s.sel, ids[0], '고르는 중인 챔피언 공유');
  B.send({ t: 'commit' }); await sleep(100);
  assert.deepEqual(spec.last.s.hist, [ids[0]]);
  R.send({ t: 'commit', id: ids[0] }); await sleep(100);
  assert.equal(spec.last.s.hist.length, 1, '중복 선택 불가');
  R.send({ t: 'commit', none: true }); await sleep(100);
  assert.deepEqual(spec.last.s.hist, [ids[0], ''], '밴 없음');
  B.send({ t: 'commit', id: 'NoSuchChampion' }); await sleep(100);
  assert.equal(spec.last.s.hist.length, 2, '없는 챔피언 불가');

  // 시간 초과 → 경기 중단
  await sleep(5300);
  assert.equal(spec.last.s.status, 'stopped', '시간 초과 시 중단');
  assert.equal(spec.last.s.stopBy, 'B');
  B.send({ t: 'commit', id: ids[1] }); B.send({ t: 'resume' }); await sleep(100);
  assert.equal(spec.last.s.status, 'stopped', '중단 중에는 선택·재개 불가(주장)');
  admin.send({ t: 'resume' }); await sleep(100);
  assert.equal(spec.last.s.status, 'live');
  assert(spec.last.s.remain > 4000, '재개하면 시간이 다시 채워짐');

  for (let i = 2; i < 20; i++) {
    const c = ORDER[i][0] === 'B' ? B : R;
    if (ORDER[i] === 'Rp' && i === 7) c.send({ t: 'commit', none: true }); // 픽 차례에는 '없음' 불가
    c.send({ t: 'commit', id: ids[i] }); await sleep(40);
  }
  await sleep(100);
  assert.equal(spec.last.s.status, 'done');
  assert.equal(spec.last.s.hist.length, 20);

  // 선수 이름, 세트 승리, 스코어
  B.send({ t: 'opts', player: { team: 'B', idx: 0, name: '탑솔러' } });
  B.send({ t: 'opts', player: { team: 'R', idx: 0, name: '남의팀' } });
  B.send({ t: 'opts', score: { B: 2, R: 0 } }); B.send({ t: 'win', team: 'B' }); await sleep(100);
  assert.equal(spec.last.s.players.B[0], '탑솔러'); assert.equal(spec.last.s.players.R[0], '', '다른 팀 선수 이름은 못 바꿈');
  assert.deepEqual(spec.last.s.score, { B: 0, R: 0 }, '스코어·승리 기록은 진행자만');
  assert.equal(spec.last.s.winsNeeded, 2, '기본은 3판 2선승');

  admin.send({ t: 'opts', fearless: true }); admin.send({ t: 'win', team: 'B' }); await sleep(100);
  assert.deepEqual(spec.last.s.score, { B: 1, R: 0 }, '승리하면 한 칸');
  assert.equal(spec.last.s.setNo, 2); assert.equal(spec.last.s.status, 'lobby'); assert.equal(spec.last.s.used.length, 10);
  admin.send({ t: 'win', team: 'B' }); await sleep(100);
  assert.deepEqual(spec.last.s.score, { B: 1, R: 0 }, '밴픽이 끝나기 전에는 승리 기록 불가');
  admin.send({ t: 'opts', bestOf: 5 }); admin.send({ t: 'opts', score: { B: 3, R: 0 } }); await sleep(100);
  assert.equal(spec.last.s.winsNeeded, 3); assert.equal(spec.last.s.seriesWinner, 'B', '5판 3선승에서 3승이면 시리즈 종료');
  admin.send({ t: 'opts', bestOf: 3 }); await sleep(100);
  assert.deepEqual(spec.last.s.score, { B: 2, R: 0 }, '선승 수를 줄이면 스코어도 맞춰짐');
  admin.send({ t: 'opts', score: { B: 1, R: 0 } }); await sleep(100);
  assert.equal(spec.last.s.seriesWinner, '');
  admin.send({ t: 'swap' }); await sleep(100);
  assert.equal(B.last.role, 'R', '진영 교체 시 주장도 반대편으로');
  assert.equal(spec.last.s.nameB, 'B');
  assert(champs.list[0].names && champs.list[0].names.ko, '챔피언 이름은 언어별로 제공');
  assert.equal(spec.last.s.players.R[0], '탑솔러'); assert.deepEqual(spec.last.s.score, { B: 0, R: 1 });
  admin.send({ t: 'start' }); await sleep(100);
  R.send({ t: 'commit', id: spec.last.s.used[0] }); await sleep(100); // 교체 후 블루는 기존 R 클라이언트
  assert.equal(spec.last.s.hist.length, 0, '피어리스: 이전 세트 픽 사용 불가');

  const none = await new Promise(res => { const w = new WebSocket(`${BASE.replace('http', 'ws')}/ws?room=nope`); w.on('message', d => res(JSON.parse(d))); });
  assert.equal(none.t, 'noroom');

  const nokey = await new Promise(res => { const w = new WebSocket(`${BASE.replace('http', 'ws')}/ws?room=${room}`); w.on('message', d => res(JSON.parse(d))); });
  assert.equal(nokey.t, 'denied', '키 없는 접속(관전)은 거부');

  console.log('모든 점검 통과');
  process.exit(0);
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
