/* 월급루팡 생존기 — 게임 규칙 엔진 (화면과 분리)
   - 고정 시간 간격(1/120초)으로만 진행하므로 기기 프레임 속도와 상관없이 같은 시드면 같은 장애물이 나옵니다.
   - 장애물은 '도착 시각' 단위의 묶음(이벤트)으로 만들고, 묶음마다 반드시 지나갈 수 있는 빈틈을 남깁니다.
     이웃한 빈틈 사이 거리는 플레이어가 실제로 이동할 수 있는 거리 안으로 제한합니다. */
(function (root) {
  'use strict';
  const W = 360, H = 640, DT = 1 / 120;
  const PLAYER = { w: 24, top: 548, bottom: 604, speed: 250 };   // 판정용 몸통(그림보다 약간 작음)
  const MARGIN = 18;                       // 빈틈 = 몸통 + 양쪽 여유 18 (반드시 지나갈 수 있는 최소 통로 60)
  const GAP = PLAYER.w + MARGIN * 2;
  const TYPES = {
    doc:    { w: 34, h: 42, v: 210, from: 0,  name: '업무 서류' },
    urgent: { w: 30, h: 42, v: 400, from: 15, name: '긴급 결재 서류' },
    box:    { w: 96, h: 56, v: 185, from: 30, name: '서류 박스' },
    coffee: { w: 26, h: 32, v: 195, from: 30, name: '커피잔', amp: 30, freq: 2.6 }
  };
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // 난이도 곡선 (게임 시간 t초 기준) — 구간마다 간격·개수·종류 비중·패턴 비중이 달라집니다.
  //  0~15 적응 / 15~30 불규칙 / 30~60 확실한 상승 / 60~90 긴급 결재 급증 / 90~120 극한 / 120~ 유지
  const PHASES = [
    { to: 15,  gap: [0.85, 1.45], cnt: [1, 2], mul: [1.00, 1.05], w: { doc: 1 },                                   pat: { single: 1 } },
    { to: 30,  gap: [0.50, 1.25], cnt: [1, 3], mul: [1.05, 1.12], w: { doc: 6, urgent: 1 },                        pat: { single: 6, stream: 2, pair: 1 } },
    { to: 60,  gap: [0.40, 0.95], cnt: [2, 3], mul: [1.12, 1.25], w: { doc: 5, urgent: 2, box: 1.5, coffee: 1 },   pat: { single: 5, stream: 3, pair: 2, wall: 1.5 } },
    { to: 90,  gap: [0.34, 0.80], cnt: [2, 4], mul: [1.25, 1.36], w: { doc: 4, urgent: 5, box: 1.5, coffee: 1.5 }, pat: { single: 4, stream: 3, pair: 2, wall: 2, rain: 2.5 } },
    { to: 120, gap: [0.30, 0.66], cnt: [3, 4], mul: [1.36, 1.50], w: { doc: 3, urgent: 6, box: 2, coffee: 2 },     pat: { single: 3, stream: 3, pair: 2.5, wall: 2.5, rain: 3 } },
    { to: 1e9, gap: [0.28, 0.60], cnt: [3, 4], mul: [1.50, 1.55], w: { doc: 3, urgent: 6, box: 2, coffee: 2 },     pat: { single: 3, stream: 3, pair: 2.5, wall: 2.5, rain: 3 } }
  ];
  function phaseOf(t) { let from = 0; for (const p of PHASES) { if (t < p.to) return { p, f: p.to > 1e8 ? Math.min(1, (t - from) / 120) : (t - from) / (p.to - from) }; from = p.to; } }
  const speedMul = t => { const { p, f } = phaseOf(t); return p.mul[0] + (p.mul[1] - p.mul[0]) * f; };
  const interval = t => { const { p } = phaseOf(t); return (p.gap[0] + p.gap[1]) / 2; };
  function weighted(w, r) { let tot = 0; for (const k in w) tot += w[k]; let x = r() * tot; for (const k in w) { x -= w[k]; if (x < 0) return k; } return Object.keys(w)[0]; }
  function Game(seed) {
    this.seed = String(seed); this.r = rng(hash(this.seed));
    this.t = 0; this.x = W / 2; this.dir = 0; this.over = false;
    this.events = []; this.pending = []; this.obs = []; this.nextTe = 3.4;   // 첫 서류는 화면 맨 위에서부터 떨어지도록 this.lastC = W / 2;
  }
  // 한 '도착 묶음'을 만든다. kinds: 이번 묶음에 쓸 종류 목록(없으면 구간 비중대로)
  Game.prototype.genEvent = function (te, n, kinds) {
    const r = this.r, m = speedMul(te), ph = phaseOf(te).p;
    // 빈틈 중심 c의 허용 범위: 겹치는 이벤트와는 같은 자리에 함께 설 수 있을 만큼, 아니면 이동 가능한 거리만큼
    let lo = GAP / 2, hi = W - GAP / 2;
    const D = MARGIN * 2 * 0.6;            // 두 빈틈이 최소 14px 이상 겹치도록
    for (const e of this.events) {
      if (e.tx < te - 3) continue;
      const free = Math.max(0, te - e.tx);
      const reach = D + PLAYER.speed * free * 0.6;
      lo = Math.max(lo, e.c - reach); hi = Math.min(hi, e.c + reach);
    }
    if (lo > hi) { lo = hi = this.lastC; }
    const c = lo + r() * (hi - lo);
    const gapL = c - GAP / 2 - 2, gapR = c + GAP / 2 + 2;
    const placed = [];
    let tx = te;
    for (let i = 0; i < n; i++) {
      const k = kinds ? kinds[i % kinds.length] : weighted(ph.w, r), T = TYPES[k], amp = T.amp || 0, ew = T.w + amp * 2;
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
    if (this.events.length > 40) this.events.shift();
    this.pending.sort((a, b) => a.spawn - b.spawn);
  };
  // 패턴: 한 번 / 연속 낙하 / 거의 동시 두 줄 / 벽(빈틈 하나만 남김) / 긴급 결재 소나기
  Game.prototype.genPattern = function () {
    const r = this.r, te = this.nextTe, ph = phaseOf(te).p, cnt = () => ph.cnt[0] + Math.floor(r() * (ph.cnt[1] - ph.cnt[0] + 1));
    const pat = weighted(ph.pat, r); let end = te;
    if (pat === 'stream') { const k = 3 + Math.floor(r() * 3); let t = te; for (let i = 0; i < k; i++) { this.genEvent(t, 1 + (r() < 0.3 ? 1 : 0), [r() < 0.25 && ph.w.urgent ? 'urgent' : 'doc']); end = t; t += 0.17 + r() * 0.14; } }
    else if (pat === 'pair') { this.genEvent(te, cnt()); end = te + 0.08 + r() * 0.1; this.genEvent(end, cnt()); }
    else if (pat === 'wall') { const kinds = r() < 0.5 || !ph.w.box ? ['doc'] : ['box', 'doc', 'doc']; this.genEvent(te, 6 + Math.floor(r() * 3), kinds); }
    else if (pat === 'rain') { const k = 2 + Math.floor(r() * 2); let t = te; for (let i = 0; i < k; i++) { this.genEvent(t, 1 + Math.floor(r() * 2), ['urgent']); end = t; t += 0.2 + r() * 0.15; } }
    else this.genEvent(te, cnt());
    const g = ph.gap; this.nextTe = end + g[0] + r() * (g[1] - g[0]);
  };
  Game.prototype.step = function () {
    if (this.over) return;
    while (this.nextTe < this.t + 4) this.genPattern();
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
  root.Lupin = { W, H, DT, PLAYER, TYPES, GAP, MARGIN, Game, hash, rng, speedMul, interval, PHASES };
})(typeof window !== 'undefined' ? window : globalThis);
