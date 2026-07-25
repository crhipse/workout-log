'use strict';

/* ===== 상수 ===== */
const STORAGE_KEY = 'workout-log-v1';
const BODY_PARTS = ['가슴', '등', '하체', '어깨', '이두', '삼두', '복근'];
const KG_PER_LB = 0.45359237;
const WEIGHT_STEP = { kg: 2.5, lb: 5 };
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

/* ===== 유틸 ===== */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function dateToStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayStr() { return dateToStr(new Date()); }

function fmtDateShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}(${DAY_NAMES[d.getDay()]})`;
}

function fmtDateFull(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${DAY_NAMES[d.getDay()]})`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return dateToStr(d);
}

/* 주 시작일(월요일) */
function weekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dateToStr(d);
}

function round1(v) { return Math.round(v * 10) / 10; }
function round3(v) { return Math.round(v * 1000) / 1000; }
function fmtNum(v) { const r = round1(v); return Number.isInteger(r) ? String(r) : r.toFixed(1); }

function toDisplay(kg, unit) { return unit === 'lb' ? kg / KG_PER_LB : kg; }
function toKg(val, unit) { return unit === 'lb' ? val * KG_PER_LB : val; }

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/* ===== 저장소 ===== */
let db;

function seedExercises() {
  const seed = {
    '가슴': ['벤치 프레스', '인클라인 벤치 프레스', '체스트 프레스', '펙덱 플라이', '딥스'],
    '등': ['데드리프트', '랫풀다운', '시티드 로우', '바벨 로우', '풀업'],
    '하체': ['스쿼트', '레그 프레스', '레그 익스텐션', '레그 컬', '카프 레이즈'],
    '어깨': ['오버헤드 프레스', '숄더 프레스 머신', '사이드 레터럴 레이즈', '리어 델트 플라이'],
    '이두': ['바벨 컬', '덤벨 컬', '케이블 컬'],
    '삼두': ['케이블 푸시다운', '라잉 트라이셉스 익스텐션', '오버헤드 익스텐션'],
    '복근': ['크런치', '레그 레이즈', '케이블 크런치'],
  };
  const out = [];
  for (const [part, names] of Object.entries(seed)) {
    for (const name of names) {
      out.push({ id: uid(), baseName: name, variant: '', bodyPart: part, unit: 'kg' });
    }
  }
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      db = JSON.parse(raw);
      db.ui = db.ui || {};
      db.exercises = db.exercises || [];
      db.sets = db.sets || [];
      return;
    }
  } catch (e) { /* 손상된 데이터면 초기화 */ }
  db = { version: 1, exercises: seedExercises(), sets: [], ui: {} };
  save();
}

function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); }

/* ===== 상태 ===== */
const state = {
  date: todayStr(),
  bodyPart: BODY_PARTS[0],
  expandedId: null,
  view: 'log', // 'log' | 'day' | 'stats'
  weekOffset: 0, // 통계 탭 주간 이동 (0 = 이번 주)
};

function shiftDate(delta) {
  const d = new Date(state.date + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  state.date = dateToStr(d);
  document.getElementById('datePicker').value = state.date;
  render();
}

/* ===== 조회 ===== */
function exById(id) { return db.exercises.find(e => e.id === id); }
function fullName(ex) { return ex.variant ? `${ex.baseName} (${ex.variant})` : ex.baseName; }

function setsOn(exId, date) {
  return db.sets.filter(s => s.exId === exId && s.date === date).sort((a, b) => a.ts - b.ts);
}

function setsInRange(from, to) {
  return db.sets.filter(s => s.date >= from && s.date <= to && exById(s.exId));
}

function sessionsFor(exId) {
  const byDate = new Map();
  for (const s of db.sets) {
    if (s.exId !== exId) continue;
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  }
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, sets]) => ({ date, sets: sets.sort((x, y) => x.ts - y.ts) }));
}

function prevSessions(exId, beforeDate, n) {
  return sessionsFor(exId).filter(sess => sess.date < beforeDate).slice(0, n);
}

function prefillDisplay(ex) {
  const today = setsOn(ex.id, state.date);
  let src = today.length ? today[today.length - 1] : null;
  if (!src) {
    const prev = prevSessions(ex.id, state.date, 1);
    if (prev.length) {
      // 지난 세션의 첫 본세트(워밍업 제외)를 시작 무게로 제안
      src = prev[0].sets.find(s => !s.warmup) || prev[0].sets[prev[0].sets.length - 1];
    }
  }
  if (src) return { w: round1(toDisplay(src.kg, ex.unit)), reps: src.reps };
  return { w: ex.unit === 'lb' ? 45 : 20, reps: 10 };
}

function fmtSet(s, unit) {
  const core = s.kg === 0 ? `맨몸×${s.reps}` : `${fmtNum(toDisplay(s.kg, unit))}×${s.reps}`;
  return s.warmup ? `W${core}` : core;
}

/* 세트를 "무게(파랑)×횟수" HTML로 — withUnit이면 무게에 단위를 붙임 (숫자만 들어가므로 안전) */
function setHTML(s, unit, withUnit) {
  const w = s.kg === 0 ? '맨몸' : fmtNum(toDisplay(s.kg, unit)) + (withUnit ? unit : '');
  return `${s.warmup ? '<span class="wu">W</span>' : ''}<span class="w">${w}</span>×${s.reps}`;
}

/* 볼륨(무게×횟수 합)·본세트 수 — 워밍업 제외 */
function volumeKg(sets) { return sets.reduce((a, s) => a + (s.warmup ? 0 : s.kg * s.reps), 0); }
function workCount(sets) { return sets.filter(s => !s.warmup).length; }
function fmtVolume(kg) { return Math.round(kg).toLocaleString('ko-KR'); }

/* ===== 렌더링 ===== */
function render() {
  const v = state.view;
  document.getElementById('tabs').hidden = v !== 'log';
  document.getElementById('addExBtn').hidden = v !== 'log';
  document.getElementById('navLog').classList.toggle('active', v === 'log');
  document.getElementById('navDay').classList.toggle('active', v === 'day');
  document.getElementById('navStats').classList.toggle('active', v === 'stats');

  if (v === 'log') renderTabs();
  const main = document.getElementById('list');
  main.innerHTML = '';
  if (v === 'log') renderLogView(main);
  else if (v === 'day') renderDayView(main);
  else renderStatsView(main);
}

function renderTabs() {
  const nav = document.getElementById('tabs');
  nav.innerHTML = '';
  for (const part of BODY_PARTS) {
    const b = el('button', 'tab' + (part === state.bodyPart ? ' active' : ''), part);
    b.onclick = () => {
      state.bodyPart = part;
      state.expandedId = null;
      db.ui.lastTab = part;
      save();
      render();
    };
    nav.appendChild(b);
  }
}

function renderLogView(main) {
  const exs = db.exercises.filter(e => e.bodyPart === state.bodyPart);
  if (!exs.length) {
    const p = el('p', 'empty');
    p.innerHTML = '이 부위에 종목이 없습니다.<br>아래 ＋ 버튼으로 추가하세요.';
    main.appendChild(p);
    return;
  }

  // 운동 이름(baseName)으로 묶고, 변형(제조사)이 있으면 같은 카드 안에 하위 줄로 표시
  const groups = new Map();
  for (const ex of exs) {
    if (!groups.has(ex.baseName)) groups.set(ex.baseName, []);
    groups.get(ex.baseName).push(ex);
  }
  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko'));

  for (const [baseName, list] of sorted) {
    if (list.length === 1 && !list[0].variant) {
      main.appendChild(exerciseCard(list[0], baseName));
    } else {
      const card = el('article', 'card');
      card.appendChild(el('div', 'group-head', baseName));
      for (const ex of list) {
        const row = el('button', 'variant-row');
        row.appendChild(el('span', 'card-title', ex.variant || '기본'));
        if (ex.unit === 'lb') row.appendChild(el('span', 'badge unit', 'lb'));
        const n = setsOn(ex.id, state.date).length;
        if (n) row.appendChild(el('span', 'badge count', `${n}세트`));
        row.appendChild(el('span', 'chev', state.expandedId === ex.id ? '▾' : '▸'));
        row.onclick = () => {
          state.expandedId = state.expandedId === ex.id ? null : ex.id;
          render();
        };
        card.appendChild(row);
        if (state.expandedId === ex.id) card.appendChild(loggerPanel(ex));
      }
      main.appendChild(card);
    }
  }
}

function renderDayView(main) {
  // 날짜 이동 바
  const nav = el('div', 'day-nav');
  const prev = el('button', 'day-nav-btn', '◀');
  prev.onclick = () => shiftDate(-1);
  const next = el('button', 'day-nav-btn', '▶');
  next.onclick = () => shiftDate(1);
  nav.append(prev, el('div', 'day-nav-title', fmtDateFull(state.date)), next);
  main.appendChild(nav);

  const daySets = db.sets.filter(s => s.date === state.date && exById(s.exId));
  if (!daySets.length) {
    main.appendChild(el('p', 'empty', '이 날짜에는 기록이 없습니다.'));
    return;
  }

  // 합계 카드
  const summary = el('article', 'card');
  const sumRow = el('div', 'day-summary');
  const stat1 = el('div', 'day-stat');
  stat1.appendChild(el('div', 'v', `${workCount(daySets)}세트`));
  stat1.appendChild(el('div', 'k', '총 본세트'));
  const stat2 = el('div', 'day-stat');
  stat2.appendChild(el('div', 'v', `${fmtVolume(volumeKg(daySets))} kg`));
  stat2.appendChild(el('div', 'k', '총 볼륨 (무게×횟수)'));
  sumRow.append(stat1, stat2);
  summary.appendChild(sumRow);
  main.appendChild(summary);

  // 부위별 카드
  const byPart = new Map();
  for (const s of daySets) {
    const ex = exById(s.exId);
    if (!byPart.has(ex.bodyPart)) byPart.set(ex.bodyPart, []);
    byPart.get(ex.bodyPart).push(s);
  }

  for (const part of BODY_PARTS) {
    if (!byPart.has(part)) continue;
    const partSets = byPart.get(part);
    const card = el('article', 'card');

    const head = el('div', 'day-part-head');
    head.appendChild(el('span', null, part));
    const stats = el('span', 'day-part-stats');
    stats.appendChild(el('span', 'badge count', `${workCount(partSets)}세트`));
    stats.appendChild(el('span', null, `${fmtVolume(volumeKg(partSets))} kg`));
    head.appendChild(stats);
    card.appendChild(head);

    // 종목별 (첫 세트 시간 순)
    const byEx = new Map();
    for (const s of partSets.sort((a, b) => a.ts - b.ts)) {
      if (!byEx.has(s.exId)) byEx.set(s.exId, []);
      byEx.get(s.exId).push(s);
    }
    for (const [exId, sets] of byEx) {
      const ex = exById(exId);
      const box = el('div', 'day-ex');
      const nameRow = el('div', 'day-ex-name');
      nameRow.appendChild(el('span', null, fullName(ex)));
      nameRow.appendChild(el('span', 'badge count', `${workCount(sets)}세트`));
      box.appendChild(nameRow);
      const setsDiv = el('div', 'day-ex-sets');
      setsDiv.innerHTML = sets.map(s => setHTML(s, ex.unit, true)).join(', ');
      box.appendChild(setsDiv);
      card.appendChild(box);
    }
    main.appendChild(card);
  }
}

function statBlock(v, k, chip) {
  const d = el('div', 'day-stat');
  d.appendChild(el('div', 'v', v));
  d.appendChild(el('div', 'k', k));
  if (chip) {
    const w = el('div', 'day-stat-delta');
    w.appendChild(chip);
    d.appendChild(w);
  }
  return d;
}

function deltaChip(cur, prv, label) {
  const chip = el('span', 'delta');
  const pre = label ? label + ' ' : '';
  if (prv <= 0) {
    chip.classList.add('flat');
    chip.textContent = pre + '—';
    return chip;
  }
  const p = Math.round(((cur - prv) / prv) * 100);
  if (p > 0) { chip.classList.add('up'); chip.textContent = `${pre}▲${p}%`; }
  else if (p < 0) { chip.classList.add('down'); chip.textContent = `${pre}▼${Math.abs(p)}%`; }
  else { chip.classList.add('flat'); chip.textContent = `${pre}0%`; }
  return chip;
}

function renderStatsView(main) {
  const md = ds => { const d = new Date(ds + 'T00:00:00'); return `${d.getMonth() + 1}/${d.getDate()}`; };

  /* ---- 주간 ---- */
  const ws = addDays(weekStart(todayStr()), state.weekOffset * 7);
  const we = addDays(ws, 6);
  const cur = setsInRange(ws, we);
  const prv = setsInRange(addDays(ws, -7), addDays(ws, -1));

  const nav = el('div', 'day-nav');
  const prevB = el('button', 'day-nav-btn', '◀');
  prevB.onclick = () => { state.weekOffset--; render(); };
  const nextB = el('button', 'day-nav-btn', '▶');
  nextB.disabled = state.weekOffset >= 0;
  nextB.onclick = () => { if (state.weekOffset < 0) { state.weekOffset++; render(); } };
  const tag = state.weekOffset === 0 ? ' · 이번 주' : (state.weekOffset === -1 ? ' · 지난주' : '');
  nav.append(prevB, el('div', 'day-nav-title', `${md(ws)} ~ ${md(we)}${tag}`), nextB);
  main.appendChild(nav);

  const sumCard = el('article', 'card');
  const row = el('div', 'day-summary');
  row.appendChild(statBlock(`${workCount(cur)}세트`, '본세트', deltaChip(workCount(cur), workCount(prv), '전주')));
  row.appendChild(statBlock(`${fmtVolume(volumeKg(cur))} kg`, '볼륨', deltaChip(volumeKg(cur), volumeKg(prv), '전주')));
  row.appendChild(statBlock(`${new Set(cur.map(s => s.date)).size}일`, '운동일수', null));
  sumCard.appendChild(row);
  main.appendChild(sumCard);

  const partCard = el('article', 'card');
  partCard.appendChild(el('div', 'day-part-head', '부위별 · 변화율은 전주 볼륨 대비'));
  let any = false;
  for (const part of BODY_PARTS) {
    const ps = cur.filter(s => exById(s.exId).bodyPart === part);
    const pp = prv.filter(s => exById(s.exId).bodyPart === part);
    if (!ps.length && !pp.length) continue;
    any = true;
    const r = el('div', 'stat-row');
    r.appendChild(el('span', 'stat-part', part));
    r.appendChild(el('span', 'badge count', `${workCount(ps)}세트`));
    r.appendChild(el('span', 'stat-vol', `${fmtVolume(volumeKg(ps))} kg`));
    r.appendChild(deltaChip(volumeKg(ps), volumeKg(pp), ''));
    partCard.appendChild(r);
  }
  if (!any) partCard.appendChild(el('div', 'stat-note', '이 주에는 기록이 없습니다.'));
  main.appendChild(partCard);

  /* ---- 월간 (주당 평균) ---- */
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const mCur = setsInRange(dateToStr(new Date(y, m, 1)), todayStr());
  const prevLast = new Date(y, m, 0); // 전달 마지막 날
  const mPrv = setsInRange(dateToStr(new Date(y, m - 1, 1)), dateToStr(prevLast));
  const wCur = now.getDate() / 7;   // 이번 달 경과 주 수
  const wPrv = prevLast.getDate() / 7;

  const csa = workCount(mCur) / wCur;
  const psa = workCount(mPrv) / wPrv;
  const cva = volumeKg(mCur) / wCur;
  const pva = volumeKg(mPrv) / wPrv;

  const mCard = el('article', 'card');
  mCard.appendChild(el('div', 'day-part-head', `월간 주당 평균 · ${m + 1}월 vs ${((m + 11) % 12) + 1}월`));

  const mkRow = (label, curTxt, prvTxt, chip) => {
    const r = el('div', 'stat-row');
    r.appendChild(el('span', 'stat-part wide', label));
    r.appendChild(el('span', 'stat-strong', curTxt));
    r.appendChild(chip);
    r.appendChild(el('span', 'stat-prev', `전달 ${prvTxt}`));
    return r;
  };
  mCard.appendChild(mkRow('세트/주', `${fmtNum(csa)}세트`, `${fmtNum(psa)}세트`, deltaChip(csa, psa, '')));
  mCard.appendChild(mkRow('볼륨/주', `${fmtVolume(cva)} kg`, `${fmtVolume(pva)} kg`, deltaChip(cva, pva, '')));
  mCard.appendChild(el('div', 'stat-note',
    `${m + 1}월 합계 ${workCount(mCur)}세트 · ${fmtVolume(volumeKg(mCur))} kg · 운동 ${new Set(mCur.map(s => s.date)).size}일 (${now.getDate()}일 경과 기준)`));
  main.appendChild(mCard);
}

function exerciseCard(ex, label) {
  const card = el('article', 'card');
  const head = el('button', 'card-head');
  head.appendChild(el('span', 'card-title', label));
  if (ex.unit === 'lb') head.appendChild(el('span', 'badge unit', 'lb'));
  const n = setsOn(ex.id, state.date).length;
  if (n) head.appendChild(el('span', 'badge count', `${n}세트`));
  head.appendChild(el('span', 'chev', state.expandedId === ex.id ? '▾' : '▸'));
  head.onclick = () => {
    state.expandedId = state.expandedId === ex.id ? null : ex.id;
    render();
  };
  card.appendChild(head);
  if (state.expandedId === ex.id) card.appendChild(loggerPanel(ex));
  return card;
}

function loggerPanel(ex) {
  const panel = el('div', 'panel');

  // 지난 기록 (최근 3회)
  const histBox = el('div', 'history');
  histBox.appendChild(el('div', 'section-title', `지난 기록 (${ex.unit})`));
  const hist = prevSessions(ex.id, state.date, 3);
  if (hist.length) {
    for (const sess of hist) {
      const line = el('div', 'hist-line');
      line.appendChild(el('span', 'hist-date', fmtDateShort(sess.date)));
      const hs = el('span', 'hist-sets');
      hs.innerHTML = sess.sets.map(s => setHTML(s, ex.unit, false)).join(', ');
      line.appendChild(hs);
      histBox.appendChild(line);
    }
  } else {
    histBox.appendChild(el('div', 'hist-line muted', '지난 기록이 없습니다'));
  }
  panel.appendChild(histBox);

  // 무게·횟수 입력
  const pre = prefillDisplay(ex);
  const step = WEIGHT_STEP[ex.unit];
  const inputRow = el('div', 'input-row');

  const wGroup = el('div', 'input-group');
  wGroup.appendChild(el('div', 'input-label', `무게 (${ex.unit})`));
  const wStep = el('div', 'stepper');
  const wMinus = el('button', 'step-btn', '−');
  const wInput = document.createElement('input');
  wInput.type = 'number';
  wInput.inputMode = 'decimal';
  wInput.min = '0';
  wInput.step = 'any';
  wInput.value = fmtNum(pre.w);
  const wPlus = el('button', 'step-btn', '＋');
  wMinus.onclick = () => { wInput.value = fmtNum(Math.max(0, (parseFloat(wInput.value) || 0) - step)); };
  wPlus.onclick = () => { wInput.value = fmtNum((parseFloat(wInput.value) || 0) + step); };
  wStep.append(wMinus, wInput, wPlus);
  wGroup.appendChild(wStep);

  const rGroup = el('div', 'input-group');
  rGroup.appendChild(el('div', 'input-label', '횟수'));
  const rStep = el('div', 'stepper');
  const rMinus = el('button', 'step-btn', '−');
  const rInput = document.createElement('input');
  rInput.type = 'number';
  rInput.inputMode = 'numeric';
  rInput.min = '1';
  rInput.step = '1';
  rInput.value = String(pre.reps);
  const rPlus = el('button', 'step-btn', '＋');
  rMinus.onclick = () => { rInput.value = String(Math.max(1, (parseInt(rInput.value, 10) || 1) - 1)); };
  rPlus.onclick = () => { rInput.value = String((parseInt(rInput.value, 10) || 0) + 1); };
  rStep.append(rMinus, rInput, rPlus);
  rGroup.appendChild(rStep);

  inputRow.append(wGroup, rGroup);
  panel.appendChild(inputRow);

  // 워밍업 토글 + 세트 기록 버튼
  const actionRow = el('div', 'action-row');
  let warmupOn = false;
  const warmBtn = el('button', 'warm-toggle', 'W 워밍업');
  warmBtn.onclick = () => { warmupOn = !warmupOn; warmBtn.classList.toggle('on', warmupOn); };
  const logBtn = el('button', 'log-btn', '✓ 세트 기록');
  logBtn.onclick = () => {
    const w = parseFloat(wInput.value);
    const reps = parseInt(rInput.value, 10);
    if (!Number.isFinite(w) || w < 0) { alert('무게를 확인해주세요.'); return; }
    if (!Number.isInteger(reps) || reps < 1) { alert('횟수를 확인해주세요.'); return; }
    db.sets.push({
      id: uid(),
      exId: ex.id,
      date: state.date,
      kg: round3(toKg(w, ex.unit)),
      reps,
      warmup: warmupOn,
      ts: Date.now(),
    });
    save();
    render();
  };
  actionRow.append(warmBtn, logBtn);
  panel.appendChild(actionRow);

  // 오늘(선택 날짜) 세트 목록
  const today = setsOn(ex.id, state.date);
  if (today.length) {
    const box = el('div', 'today');
    box.appendChild(el('div', 'today-title',
      state.date === todayStr() ? '오늘 기록' : `${fmtDateShort(state.date)} 기록`));
    today.forEach((s, i) => {
      const row = el('div', 'set-row');
      row.appendChild(el('span', 'set-idx', String(i + 1)));
      const label = s.kg === 0
        ? `맨몸 × ${s.reps}회`
        : `${fmtNum(toDisplay(s.kg, ex.unit))} ${ex.unit} × ${s.reps}회`;
      row.appendChild(el('span', 'set-label', label));
      if (s.warmup) row.appendChild(el('span', 'badge warm', 'W'));
      const del = el('button', 'set-del', '✕');
      del.setAttribute('aria-label', '세트 삭제');
      del.onclick = () => {
        db.sets = db.sets.filter(x => x.id !== s.id);
        save();
        render();
      };
      row.appendChild(del);
      box.appendChild(row);
    });
    panel.appendChild(box);
  }

  // 종목 수정·삭제
  const manage = el('div', 'manage-row');
  const editBtn = el('button', 'link-btn', '종목 수정');
  editBtn.onclick = () => openExDialog(ex);
  const delBtn = el('button', 'link-btn danger', '종목 삭제');
  delBtn.onclick = () => {
    const cnt = db.sets.filter(s => s.exId === ex.id).length;
    const msg = cnt
      ? `"${fullName(ex)}" 종목과 기록 ${cnt}세트가 모두 삭제됩니다. 계속할까요?`
      : `"${fullName(ex)}" 종목을 삭제할까요?`;
    if (!confirm(msg)) return;
    db.exercises = db.exercises.filter(e => e.id !== ex.id);
    db.sets = db.sets.filter(s => s.exId !== ex.id);
    state.expandedId = null;
    save();
    render();
  };
  manage.append(editBtn, delBtn);
  panel.appendChild(manage);

  return panel;
}

/* ===== 엑셀 내보내기 ===== */
const LOG_HEADER = ['날짜', '요일', '부위', '운동', '구분', '단위', '무게(입력단위)', '무게(kg)', '횟수', '워밍업', '볼륨(kg)'];
const LOG_COLS = [{ wch: 11 }, { wch: 5 }, { wch: 6 }, { wch: 22 }, { wch: 12 }, { wch: 5 }, { wch: 13 }, { wch: 9 }, { wch: 6 }, { wch: 7 }, { wch: 10 }];

function logRow(s) {
  const ex = exById(s.exId);
  const d = new Date(s.date + 'T00:00:00');
  return [
    s.date, DAY_NAMES[d.getDay()], ex.bodyPart, ex.baseName, ex.variant || '', ex.unit,
    round1(toDisplay(s.kg, ex.unit)), round1(s.kg), s.reps,
    s.warmup ? 'W' : '', s.warmup ? 0 : Math.round(s.kg * s.reps * 10) / 10,
  ];
}

function logSheet(rows) {
  const ws = XLSX.utils.aoa_to_sheet([LOG_HEADER, ...rows.map(logRow)]);
  ws['!cols'] = LOG_COLS;
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: LOG_HEADER.length - 1 } }) };
  return ws;
}

function buildWorkbook() {
  const sets = db.sets.filter(s => exById(s.exId)).slice()
    .sort((a, b) => (a.date === b.date ? a.ts - b.ts : a.date.localeCompare(b.date)));
  if (!sets.length) return null;
  const wb = XLSX.utils.book_new();

  // ① 전체 로그 + ② 부위별 시트
  XLSX.utils.book_append_sheet(wb, logSheet(sets), '전체 로그');
  for (const part of BODY_PARTS) {
    const ps = sets.filter(s => exById(s.exId).bodyPart === part);
    if (ps.length) XLSX.utils.book_append_sheet(wb, logSheet(ps), part);
  }

  // 주 목록 (첫 기록 주 ~ 이번 주)
  const weeks = [];
  const lastWeek = weekStart(todayStr());
  for (let w = weekStart(sets[0].date); w <= lastWeek; w = addDays(w, 7)) weeks.push(w);
  const weekLabel = w => `${w} ~ ${addDays(w, 6)}`;
  const partSetsOf = (list, part) => list.filter(s => exById(s.exId).bodyPart === part);

  // ③ 주간 세트수 / ④ 주간 볼륨
  const header = ['주', ...BODY_PARTS, '합계'];
  const cntRows = [header];
  const volRows = [header];
  for (const w of weeks) {
    const inWk = setsInRange(w, addDays(w, 6));
    const cnts = BODY_PARTS.map(p => workCount(partSetsOf(inWk, p)));
    const vols = BODY_PARTS.map(p => Math.round(volumeKg(partSetsOf(inWk, p))));
    cntRows.push([weekLabel(w), ...cnts, cnts.reduce((a, b) => a + b, 0)]);
    volRows.push([weekLabel(w), ...vols, vols.reduce((a, b) => a + b, 0)]);
  }
  const wCols = [{ wch: 24 }, ...BODY_PARTS.map(() => ({ wch: 8 })), { wch: 9 }];
  const wsCnt = XLSX.utils.aoa_to_sheet(cntRows);
  wsCnt['!cols'] = wCols;
  XLSX.utils.book_append_sheet(wb, wsCnt, '주간 세트수');
  const wsVol = XLSX.utils.aoa_to_sheet(volRows);
  wsVol['!cols'] = wCols;
  XLSX.utils.book_append_sheet(wb, wsVol, '주간 볼륨(kg)');

  // ⑤ 평균·변화
  const avgRows = [];
  avgRows.push(['[주별 합계 · 전주 대비 변화]']);
  avgRows.push(['주', '세트', '볼륨(kg)', '세트 변화(%)', '볼륨 변화(%)']);
  let pc = null, pv = null;
  for (const w of weeks) {
    const inWk = setsInRange(w, addDays(w, 6));
    const c = workCount(inWk), v = Math.round(volumeKg(inWk));
    avgRows.push([
      weekLabel(w), c, v,
      pc > 0 ? Math.round(((c - pc) / pc) * 100) : '',
      pv > 0 ? Math.round(((v - pv) / pv) * 100) : '',
    ]);
    pc = c; pv = v;
  }

  avgRows.push([]);
  avgRows.push(['[월별 요약 · 주당 평균과 전달 대비 변화]']);
  avgRows.push(['월', '세트', '볼륨(kg)', '운동일수', '세트/주', '볼륨/주(kg)', '세트/주 변화(%)', '볼륨/주 변화(%)']);
  const now = new Date();
  const cy = now.getFullYear(), cm = now.getMonth() + 1;
  let my = +sets[0].date.slice(0, 4), mm = +sets[0].date.slice(5, 7);
  let psa = null, pva = null;
  while (my < cy || (my === cy && mm <= cm)) {
    const mmStr = String(mm).padStart(2, '0');
    const lastDay = new Date(my, mm, 0).getDate();
    const isCur = my === cy && mm === cm;
    const from = `${my}-${mmStr}-01`;
    const to = isCur ? todayStr() : `${my}-${mmStr}-${String(lastDay).padStart(2, '0')}`;
    const inM = setsInRange(from, to);
    const wkCount = (isCur ? now.getDate() : lastDay) / 7;
    const c = workCount(inM), v = Math.round(volumeKg(inM));
    const sa = round1(c / wkCount), va = Math.round(v / wkCount);
    avgRows.push([
      `${my}-${mmStr}`, c, v, new Set(inM.map(s => s.date)).size, sa, va,
      psa > 0 ? Math.round(((sa - psa) / psa) * 100) : '',
      pva > 0 ? Math.round(((va - pva) / pva) * 100) : '',
    ]);
    psa = sa; pva = va;
    mm++; if (mm === 13) { mm = 1; my++; }
  }
  const wsAvg = XLSX.utils.aoa_to_sheet(avgRows);
  wsAvg['!cols'] = [{ wch: 24 }, { wch: 7 }, { wch: 10 }, { wch: 9 }, { wch: 8 }, { wch: 11 }, { wch: 14 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, wsAvg, '평균·변화');

  return wb;
}

function exportExcel() {
  if (typeof XLSX === 'undefined') { alert('엑셀 라이브러리를 불러오지 못했습니다. 새로고침 후 다시 시도해주세요.'); return; }
  const wb = buildWorkbook();
  if (!wb) { alert('내보낼 기록이 없습니다.'); return; }
  XLSX.writeFile(wb, `운동기록_${todayStr()}.xlsx`);
}

/* ===== 종목 추가/수정 다이얼로그 ===== */
let editingId = null;
let dlgUnit = 'kg';

function setDlgUnit(u) {
  dlgUnit = u;
  document.querySelectorAll('#exUnitSeg button').forEach(b => {
    b.classList.toggle('active', b.dataset.unit === u);
  });
}

function openExDialog(ex = null) {
  editingId = ex ? ex.id : null;
  document.getElementById('exDialogTitle').textContent = ex ? '종목 수정' : '종목 추가';

  const sel = document.getElementById('exBodyPart');
  sel.innerHTML = '';
  for (const p of BODY_PARTS) {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p;
    sel.appendChild(o);
  }
  sel.value = ex ? ex.bodyPart : state.bodyPart;

  document.getElementById('exName').value = ex ? ex.baseName : '';
  document.getElementById('exVariant').value = ex ? ex.variant : '';
  setDlgUnit(ex ? ex.unit : 'kg');

  const dl = document.getElementById('baseNameList');
  dl.innerHTML = '';
  const names = [...new Set(db.exercises.map(e => e.baseName))].sort((a, b) => a.localeCompare(b, 'ko'));
  for (const n of names) {
    const o = document.createElement('option');
    o.value = n;
    dl.appendChild(o);
  }

  document.getElementById('exDialog').showModal();
}

/* ===== 초기화 ===== */
function init() {
  load();
  state.bodyPart = (db.ui.lastTab && BODY_PARTS.includes(db.ui.lastTab)) ? db.ui.lastTab : BODY_PARTS[0];

  const dp = document.getElementById('datePicker');
  dp.value = state.date;
  dp.onchange = () => {
    if (dp.value) {
      state.date = dp.value;
      render();
    }
  };

  document.getElementById('navLog').onclick = () => { state.view = 'log'; render(); };
  document.getElementById('navDay').onclick = () => { state.view = 'day'; render(); };
  document.getElementById('navStats').onclick = () => { state.view = 'stats'; state.weekOffset = 0; render(); };

  document.getElementById('addExBtn').onclick = () => openExDialog();
  document.getElementById('exCancelBtn').onclick = () => document.getElementById('exDialog').close();

  document.getElementById('exForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('exName').value.trim();
    const variant = document.getElementById('exVariant').value.trim();
    const bodyPart = document.getElementById('exBodyPart').value;
    if (!name) return;

    if (editingId) {
      const ex = exById(editingId);
      if (ex) Object.assign(ex, { baseName: name, variant, bodyPart, unit: dlgUnit });
    } else {
      const ex = { id: uid(), baseName: name, variant, bodyPart, unit: dlgUnit };
      db.exercises.push(ex);
      state.bodyPart = bodyPart;
      db.ui.lastTab = bodyPart;
      state.expandedId = ex.id;
    }
    save();
    document.getElementById('exDialog').close();
    render();
  });

  document.querySelectorAll('#exUnitSeg button').forEach(b => {
    b.onclick = () => setDlgUnit(b.dataset.unit);
  });

  // 설정
  const settingsDialog = document.getElementById('settingsDialog');
  document.getElementById('settingsBtn').onclick = () => settingsDialog.showModal();
  document.getElementById('settingsCloseBtn').onclick = () => settingsDialog.close();

  document.getElementById('exportBtn').onclick = () => exportExcel();

  document.getElementById('backupBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `운동기록-백업-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const restoreFile = document.getElementById('restoreFile');
  document.getElementById('restoreBtn').onclick = () => restoreFile.click();
  restoreFile.onchange = () => {
    const file = restoreFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        if (!Array.isArray(obj.exercises) || !Array.isArray(obj.sets)) throw new Error('bad format');
        if (!confirm('백업 데이터로 교체합니다. 현재 기록을 덮어씁니다. 계속할까요?')) return;
        db = obj;
        db.ui = db.ui || {};
        save();
        state.expandedId = null;
        settingsDialog.close();
        render();
      } catch (err) {
        alert('올바른 백업 파일이 아닙니다.');
      }
    };
    reader.readAsText(file);
    restoreFile.value = '';
  };

  document.getElementById('wipeBtn').onclick = () => {
    if (!confirm('모든 종목과 기록이 삭제되고 기본 상태로 돌아갑니다. 계속할까요?')) return;
    localStorage.removeItem(STORAGE_KEY);
    load();
    state.bodyPart = BODY_PARTS[0];
    state.expandedId = null;
    settingsDialog.close();
    render();
  };

  render();

  // 배포(https) 환경에서만 서비스 워커 등록 — 오프라인 지원
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
