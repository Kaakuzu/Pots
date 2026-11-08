/* Pots – class sentence game. Modes: (none)=student, ?mode=teacher, ?mode=display */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const letter = n => String.fromCharCode(65 + n);
const mode = new URLSearchParams(location.search).get('mode') || 'student';
document.body.className = 'mode-' + mode;

const S = { game: {}, sentences: {}, players: {}, filled: {}, pending: {} };
let uid = null, isTeacher = false, ready = false, started = false, editorFor = null;

function fail(e) { const b = $('err'); b.hidden = false; b.textContent = 'Firebase error: ' + (e.message || e); }
if (firebaseConfig.apiKey.startsWith('PASTE')) fail('Fill in firebase-config.js first.');
firebase.initializeApp(firebaseConfig);
const db = firebase.database();
firebase.auth().onAuthStateChanged(u => { if (u && !started) { uid = u.uid; started = true; start(); } });
firebase.auth().signInAnonymously().catch(fail);

async function start() {
  try { isTeacher = (await db.ref('teachers/' + uid).get()).exists(); } catch (e) { isTeacher = false; }
  ['game', 'sentences', 'players', 'filled', 'pending'].forEach(k =>
    db.ref(k).on('value', s => { S[k] = s.val() || {}; render(); }, fail));
  ready = true; render();
  if (isTeacher) seedIfEmpty();
}

/* ---------- helpers ---------- */
const potSize = () => S.game.potSize || 3;
const sid = () => S.game.sentenceId;
const potOf = p => Math.ceil(p.number / potSize());
const slotOf = p => (p.number - 1) % potSize();

function parse(text) {           // "The {noun:A} ran" -> parts
  const parts = []; let last = 0, i = 0;
  text.replace(/\{([^:}]*):([A-Za-z])\}/g, (m, kind, slot, off) => {
    parts.push({ t: text.slice(last, off) });
    parts.push({ blank: i++, kind: kind.trim() || 'word', slot: slot.toUpperCase() });
    last = off + m.length; return m;
  });
  parts.push({ t: text.slice(last) });
  return parts;
}

function potState(pot) {
  const s = S.sentences[sid()]; if (!s) return null;
  const parts = parse(s.text), blanks = parts.filter(p => p.blank !== undefined);
  const f = (S.filled[sid()] || {})[pot] || {};
  const pend = (S.pending[sid()] || {})[pot] || null;
  const cur = blanks.find(b => f[b.blank] == null) || null;
  return { parts, blanks, f, pend, cur };
}
const members = pot => Object.values(S.players).filter(p => potOf(p) === pot).sort((a, b) => a.number - b.number);
const playerFor = (pot, slot) => members(pot).find(p => letter(slotOf(p)) === slot);

/* ---------- routing ---------- */
function render() {
  if (!ready) return;
  const asTeacher = mode === 'teacher';
  const view = mode === 'display' ? 'Board' : asTeacher ? (isTeacher ? 'Board' : 'Login') : (S.players[uid] ? 'Student' : 'Join');
  ['Join', 'Student', 'Login', 'Board'].forEach(v => $('v' + v).hidden = v !== view);
  $('ctl').hidden = !(asTeacher && isTeacher);
  if (view === 'Board') renderBoard();
  if (view === 'Student') renderStudent();
  if (asTeacher && isTeacher) renderControls();
}

/* ---------- student ---------- */
$('jGo').onclick = async () => {
  const name = $('jName').value.trim(); if (!name) return;
  $('jGo').disabled = true;
  try {
    const r = await db.ref('counter').transaction(c => (c || 0) + 1);
    await db.ref('players/' + uid).set({ name, number: r.snapshot.val() });
  } catch (e) { fail(e); $('jGo').disabled = false; }
};
$('jName').onkeydown = e => { if (e.key === 'Enter') $('jGo').click(); };

function renderStudent() {
  const me = S.players[uid], pot = potOf(me), slot = letter(slotOf(me)), st = potState(pot);
  $('sName').textContent = me.name; $('sNum').textContent = me.number;
  $('sPot').textContent = pot; $('sSlot').textContent = slot;
  let can = false, msg;
  if (!st) msg = 'Waiting for the teacher to start.';
  else if (!st.cur) msg = 'Your pot is finished. Wait for the next sentence.';
  else if (st.cur.slot !== slot) { const w = playerFor(pot, st.cur.slot); msg = `Waiting for ${st.cur.slot}${w ? ' (' + w.name + ')' : ''}.`; }
  else if (st.pend && st.pend.status === 'pending') msg = 'Sent. The teacher is checking it.';
  else { can = true; msg = st.pend ? 'Not accepted. Try another word.' : `Your turn. Type a ${st.cur.kind}.`; }
  $('sMsg').textContent = msg;
  $('sInput').disabled = !can; $('sSend').disabled = !can;
  if (!can) $('sInput').value = ''; else if (document.activeElement !== $('sInput')) $('sInput').focus();
}
$('sSend').onclick = () => {
  const me = S.players[uid], pot = potOf(me), st = potState(pot), text = $('sInput').value.trim();
  if (!st || !st.cur || !text || st.cur.slot !== letter(slotOf(me))) return;
  $('sSend').disabled = true;
  db.ref(`pending/${sid()}/${pot}`).set({ blank: st.cur.blank, text, name: me.name, uid, status: 'pending' }).catch(fail);
  $('sInput').value = '';
};
$('sInput').onkeydown = e => { if (e.key === 'Enter') $('sSend').click(); };

/* ---------- teacher login ---------- */
$('tGo').onclick = async () => {
  try { await db.ref('teachers/' + uid).set($('tSecret').value); isTeacher = true; seedIfEmpty(); render(); }
  catch (e) { $('tMsg').textContent = 'Wrong secret.'; }
};
$('tSecret').onkeydown = e => { if (e.key === 'Enter') $('tGo').click(); };

/* ---------- board (teacher + display) ---------- */
function renderBoard() {
  $('joinHint').textContent = `Students join at ${location.origin}${location.pathname}`;
  const nums = [...new Set(Object.values(S.players).map(potOf))].sort((a, b) => a - b);
  if (!nums.length) { $('pots').innerHTML = '<div class="empty">Waiting for students to join…</div>'; return; }
  if (!S.sentences[sid()]) { $('pots').innerHTML = '<div class="empty">No sentence selected yet.</div>'; return; }
  const open = [...document.querySelectorAll('.act input')].map(i => [i.dataset.pot, i.value, i === document.activeElement]);
  $('pots').innerHTML = nums.map(potHTML).join('');
  open.forEach(([p, v, focus]) => { const i = document.querySelector(`.act input[data-pot="${p}"]`); if (i) { i.value = v; if (focus) i.focus(); } });
}

function potHTML(pot) {
  const st = potState(pot);
  const who = members(pot).map(p => `<span>${letter(slotOf(p))}: ${esc(p.name)} <small>#${p.number}</small></span>`).join('');
  const sent = st.parts.map(p => {
    if (p.blank === undefined) return esc(p.t);
    const w = st.f[p.blank];
    if (w != null) return `<b class="w ok">${esc(w)}</b>`;
    if (st.cur && st.cur.blank === p.blank && st.pend)
      return `<b class="w ${st.pend.status === 'rejected' ? 'rej' : 'pend'}">${esc(st.pend.text)}</b>`;
    return `<b class="w ${st.cur && st.cur.blank === p.blank ? 'cur' : ''}">${esc(p.kind)} (${p.slot})</b>`;
  }).join('');
  let act = '';
  if (mode === 'teacher' && st.cur) {
    if (st.pend && st.pend.status === 'pending')
      act = `<div class="act"><button data-do="lock" data-pot="${pot}">Lock in</button><button class="ghost" data-do="reject" data-pot="${pot}">Reject</button></div>`;
    else
      act = `<div class="act"><input data-pot="${pot}" placeholder="Fill ${esc(st.cur.kind)} (${st.cur.slot}) yourself"><button class="ghost" data-do="fill" data-pot="${pot}">Fill</button></div>`;
  }
  return `<article class="pot ${st.cur ? '' : 'complete'}"><h2>Pot ${pot}</h2><div class="who">${who}</div>
    <div class="sent">${sent}</div>${st.cur ? '' : '<span class="done">Done</span>'}${act}</article>`;
}

$('pots').onclick = e => {
  const b = e.target.closest('button[data-do]'); if (!b) return;
  const pot = +b.dataset.pot, st = potState(pot); if (!st || !st.cur) return;
  const base = `${sid()}/${pot}`;
  if (b.dataset.do === 'lock' && st.pend)
    db.ref().update({ [`filled/${base}/${st.cur.blank}`]: st.pend.text, [`pending/${base}`]: null }).catch(fail);
  if (b.dataset.do === 'reject')
    db.ref(`pending/${base}/status`).set('rejected').catch(fail);
  if (b.dataset.do === 'fill') {
    const i = document.querySelector(`.act input[data-pot="${pot}"]`), t = i.value.trim(); if (!t) return;
    db.ref().update({ [`filled/${base}/${st.cur.blank}`]: t, [`pending/${base}`]: null }).catch(fail);
  }
};

/* ---------- teacher controls ---------- */
const ids = () => Object.keys(S.sentences);
function renderControls() {
  const sel = $('cSel');
  sel.innerHTML = ids().map(k => `<option value="${k}">${esc(S.sentences[k].title || 'Untitled')}</option>`).join('');
  sel.value = sid() || '';
  if (document.activeElement !== $('cPot')) $('cPot').value = potSize();
  if (editorFor !== sid() && S.sentences[sid()]) {
    editorFor = sid();
    $('eTitle').value = S.sentences[sid()].title || ''; $('eText').value = S.sentences[sid()].text || '';
  }
}
const go = k => k && db.ref('game/sentenceId').set(k);
$('cSel').onchange = e => go(e.target.value);
$('cPrev').onclick = () => go(ids()[ids().indexOf(sid()) - 1]);
$('cNext').onclick = () => go(ids()[ids().indexOf(sid()) + 1]);
$('cPot').onchange = e => db.ref('game/potSize').set(Math.max(1, Math.min(8, +e.target.value || 3)));
$('cReset').onclick = () => confirm('Clear all answers for this sentence?') &&
  db.ref().update({ ['filled/' + sid()]: null, ['pending/' + sid()]: null });
$('cClass').onclick = () => confirm('Remove all students and restart numbering?') &&
  db.ref().update({ players: null, counter: 0 });
$('eSave').onclick = () => sid() && db.ref('sentences/' + sid()).set({ title: $('eTitle').value.trim() || 'Untitled', text: $('eText').value });
$('eNew').onclick = () => {
  const r = db.ref('sentences').push();
  r.set({ title: 'New sentence', text: 'The {adjective:A} {noun:B} {verb:C}.' }).then(() => { editorFor = null; go(r.key); });
};
$('eDel').onclick = () => sid() && confirm('Delete this sentence?') && db.ref('sentences/' + sid()).remove().then(() => { editorFor = null; go(ids().find(k => k !== sid())); });

function seedIfEmpty() {
  if (Object.keys(S.sentences).length) return;
  db.ref('sentences').get().then(s => {
    if (s.exists()) return;
    const a = db.ref('sentences').push(), b = db.ref('sentences').push();
    a.set({ title: 'Adjectives and nouns', text: 'The {adjective:A} {noun:B} {verb ending in -ed:C} over the {adjective:A} {noun:B}.' });
    b.set({ title: 'Weekend plans', text: 'Yesterday the {noun:A} decided to {verb:B} with a {adjective:C} {noun:A}.' });
    db.ref('game').update({ sentenceId: a.key, potSize: 3 });
  });
}
