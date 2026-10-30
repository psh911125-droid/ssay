/* 월급루팡 생존기 — 게임 규칙 엔진 (화면과 분리)
   - 고정 시간 간격(1/120초)으로만 진행하므로 기기 프레임 속도와 상관없이 같은 시드면 같은 장애물이 나옵니다.
   - 장애물은 '도착 시각' 단위의 묶음(이벤트)으로 만들고, 묶음마다 반드시 지나갈 수 있는 빈틈을 남깁니다.
     이웃한 빈틈 사이 거리는 플레이어가 실제로 이동할 수 있는 거리 안으로 제한합니다. */
(function (root) {
  'use strict';
  const W = 360, H = 640, DT = 1 / 120;
  const PLAYER = { w: 24, top: 548, bottom: 604, speed: 250 };   // 판정용 몸통(그림보다 약간 작음)
  const MARGIN = 22;                       // 빈틈 = 몸통 + 양쪽 여유 22
  const GAP = PLAYER.w + MARGIN * 2;
  const TYPES = {
    doc:    { w: 34, h: 42, v: 210, from: 0,  name: '업무 서류' },
    urgent: { w: 30, h: 42, v: 400, from: 20, name: '긴급 결재 서류' },
    box:    { w: 96, h: 56, v: 185, from: 40, name: '서류 박스' },
    coffee: { w: 26, h: 32, v: 195, from: 60, name: '커피잔', amp: 30, freq: 2.6 }
  };
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // 난이도 곡선 (초 단위 게임 시간 기준)
  const speedMul = t => t < 90 ? 1 + t / 450 : Math.min(1.7, 1.2 + (t - 90) / 300);
  const interval = t => t < 90 ? 0.95 - 0.33 * t / 90 : Math.max(0.42, 0.62 - (t - 90) / 600);
  function countFor(t, r) { const lo = t < 20 ? 1 : t < 60 ? 2 : 2, hi = t < 20 ? 2 : t < 60 ? 3 : 4; return lo + Math.floor(r() * (hi - lo + 1)); }
  function pickType(t, r) {
    const w = { doc: 5, urgent: t >= 20 ? 3 : 0, box: t >= 40 ? 2 : 0, coffee: t >= 60 ? 2.5 : 0 };
    let tot = 0; for (const k in w) tot += w[k]; let x = r() * tot;
    for (const k in w) { x -= w[k]; if (x < 0) return k; } return 'doc';
  }

  function Game(seed) {
    this.seed = String(seed); this.r = rng(hash(this.seed));
    this.t = 0; this.x = W / 2; this.dir = 0; this.over = false;
    this.events = []; this.pending = []; this.obs = []; this.nextTe = 3.4;   // 첫 서류는 화면 맨 위에서부터 떨어지도록 this.lastC = W / 2;
  }
  Game.prototype.genEvent = function () {
    const r = this.r, te = this.nextTe, m = speedMul(te);
    // 빈틈 중심 c의 허용 범위: 겹치는 이벤트와는 같은 자리에 함께 설 수 있을 만큼, 아니면 이동 가능한 거리만큼
    let lo = GAP / 2, hi = W - GAP / 2;
    const D = MARGIN * 2 * 0.6;            // 두 빈틈이 최소 17px 이상 겹치도록
    for (const e of this.events) {
      if (e.tx < te - 3) continue;
      const free = Math.max(0, te - e.tx);
      const reach = D + PLAYER.speed * free * 0.6;
      lo = Math.max(lo, e.c - reach); hi = Math.min(hi, e.c + reach);
    }
    if (lo > hi) { lo = hi = this.lastC; }
    const c = lo + r() * (hi - lo);
    const gapL = c - GAP / 2 - 2, gapR = c + GAP / 2 + 2;
    const n = countFor(te, r), placed = [];
    let tx = te;
    for (let i = 0; i < n; i++) {
      const k = pickType(te, r), T = TYPES[k], amp = T.amp || 0, ew = T.w + amp * 2;
      let ok = false, x0 = 0;
      for (let tries = 0; tries < 8 && !ok; tries++) {
        const left = r() * (W - ew);            // 흔들림까지 포함한 차지 범위 [left, left+ew]
        if (left + ew > gapL && left < gapR) continue;
        if (placed.some(p => left < p.r + 4 && left + ew > p.l - 4)) continue;
        ok = true; x0 = left + amp;
        placed.push({ l: left, r: left + ew });
      }
      if (!ok) continue;
      const v = T.v * m, spawn = te - PLAYER.top / v, exit = spawn + (PLAYER.bottom + T.h) / v;
      tx = Math.max(tx, exit);
      this.pending.push({ k, w: T.w, h: T.h, v, x0, x: x0, y: -T.h, spawn, amp, freq: T.freq || 0, ph: r() * Math.PI * 2 });
    }
    this.events.push({ te, tx, c }); this.lastC = c;
    if (this.events.length > 30) this.events.shift();
    this.pending.sort((a, b) => a.spawn - b.spawn);
    this.nextTe = te + interval(te) * (0.8 + r() * 0.4);
  };
  Game.prototype.step = function () {
    if (this.over) return;
    while (this.nextTe < this.t + 4) this.genEvent();
    this.t += DT;
    const t = this.t;
    while (this.pending.length && this.pending[0].spawn <= t) this.obs.push(this.pending.shift());
    this.x = Math.max(PLAYER.w / 2, Math.min(W - PLAYER.w / 2, this.x + this.dir * PLAYER.speed * DT));
    const pl = this.x - PLAYER.w / 2, pr = this.x + PLAYER.w / 2;
    for (const o of this.obs) {
      const a = t - o.spawn; o.y = -o.h + o.v * a;
      o.x = o.amp ? o.x0 + o.amp * Math.sin(o.freq * a + o.ph) : o.x0;
      if (o.y + o.h - 2 > PLAYER.top && o.y + 2 < PLAYER.bottom && o.x + o.w - 2 > pl && o.x + 2 < pr) { this.over = true; this.hit = o; }
    }
    this.obs = this.obs.filter(o => o.y < H + 10);
  };
  root.Lupin = { W, H, DT, PLAYER, TYPES, GAP, MARGIN, Game, hash, rng, speedMul, interval };
})(typeof window !== 'undefined' ? window : globalThis);
