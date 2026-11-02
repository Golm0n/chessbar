import { Chess } from './vendor/chess.js';
import { Chessground } from './vendor/chessground/chessground.min.js';

/* ---------- Réglages ---------- */
const MIN_DEPTH = 14;   // la barre ne bouge qu'à partir de cette profondeur
const MAX_DEPTH = 17;   // profondeur maximale atteinte si on attend
const FLAG_GRACE = 2000; // ms de marge avant de déclarer l'adversaire au temps (latence réseau)
const ROOM_PREFIX = 'echecsbarre-';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const $ = (id) => document.getElementById(id);
const show = (id) => { for (const s of ['lobby', 'waiting', 'game']) $(s).hidden = s !== id; };

/* ---------- Moteur d'évaluation (Stockfish WASM) ---------- */
class Evaluator {
  constructor(onEval, onState) {
    this.onEval = onEval;
    this.onState = onState;
    this.ready = false;
    this.running = false;
    this.stale = 0;          // nombre de "bestmove" d'anciennes recherches à ignorer
    this.pending = null;     // position à évaluer dès que le moteur est prêt
    this.fen = null;
    this.lastInfo = null;
    this.worker = new Worker('vendor/stockfish-19-lite-single.js');
    this.worker.onmessage = (e) => this.onLine(String(e.data));
    this.worker.onerror = () => this.onState('Moteur indisponible');
    this.post('uci');
  }
  post(cmd) { this.worker.postMessage(cmd); }
  onLine(line) {
    if (line === 'uciok') { this.post('isready'); return; }
    if (line === 'readyok') {
      this.ready = true;
      this.onState('');
      if (this.pending) { const f = this.pending; this.pending = null; this.evaluate(f); }
      return;
    }
    if (line.startsWith('bestmove')) {
      if (this.stale > 0) { this.stale--; return; }
      this.running = false;
      // Recherche terminée avant MIN_DEPTH (mat forcé, coup unique…) : on applique le dernier résultat
      if (this.lastInfo && !this.lastInfo.emitted) this.emit(this.lastInfo);
      return;
    }
    if (!line.startsWith('info') || this.stale > 0) return;
    const m = line.match(/ depth (\d+) .*?score (cp|mate) (-?\d+)( lowerbound| upperbound)?/);
    if (!m || m[4]) return;
    const depth = +m[1];
    const val = +m[3];
    const white = this.fen.split(' ')[1] === 'w';
    let cp = m[2] === 'mate' ? (val > 0 ? 10000 : -10000) : val;
    if (m[2] === 'mate' && val === 0) return;
    if (!white) cp = -cp;
    const info = { cp, depth, emitted: false };
    this.lastInfo = info;
    if (depth >= MIN_DEPTH) this.emit(info);
  }
  emit(info) { info.emitted = true; this.onEval(info.cp, info.depth); }
  evaluate(fen) {
    if (!this.ready) { this.pending = fen; return; }
    if (this.running) { this.stale++; this.post('stop'); }
    this.fen = fen;
    this.lastInfo = null;
    this.running = true;
    this.post('position fen ' + fen);
    this.post('go depth ' + MAX_DEPTH);
  }
  stop() {
    this.pending = null;
    if (this.running) { this.stale++; this.post('stop'); this.running = false; }
  }
}

// Pourcentage de victoire des Blancs, même formule que Lichess
const whitePct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);

function setBar(pct) { $('evalfill').style.height = Math.max(0, Math.min(100, pct)) + '%'; }

/* ---------- État de la partie ---------- */
let game = null;
let cg = null;
let evaluator = null;
let myColor = 'w';
let peer = null;
let conn = null;
let isHost = false;
let over = false;
let iWantRematch = false;
let theyWantRematch = false;
let positions = [];      // { fen, last, san, check } par demi-coup, positions[0] = départ
let view = 0;            // indice de la position affichée
let evals = [];          // % Blancs connu par position (sert à la barre dans l'historique)
let tc = null;           // cadence { ms, inc }, null = sans limite
let clocks = { w: 0, b: 0 };
let runStart = null;     // Date.now() du début du trait en cours, null = pendules à l'arrêt

const colorName = (c) => (c === 'w' ? 'white' : 'black');

function makePeer(id) {
  const opts = { debug: 0 };
  const ps = new URLSearchParams(location.search).get('peerServer'); // pour tests locaux
  if (ps) { const [host, port] = ps.split(':'); Object.assign(opts, { host, port: +port, path: '/', secure: false }); }
  return id ? new Peer(id, opts) : new Peer(opts);
}

function randomCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

/* ---------- Lobby : créer / rejoindre ---------- */
function lobbyError(msg) { const e = $('lobby-error'); e.textContent = msg; e.hidden = !msg; }

function readTc() {
  const min = Math.min(180, Math.max(0, +$('tc-min').value || 0));
  const inc = Math.min(60, Math.max(0, +$('tc-inc').value || 0));
  return min > 0 ? { ms: min * 60000, inc: inc * 1000 } : null;
}

function createRoom() {
  lobbyError('');
  isHost = true;
  tc = readTc();
  const code = randomCode();
  const p = makePeer(ROOM_PREFIX + code);
  peer = p;
  p.on('open', () => {
    $('room-code').textContent = code;
    $('tc-label').textContent = tc ? `Cadence : ${tc.ms / 60000} min + ${tc.inc / 1000} s` : 'Sans limite de temps';
    show('waiting');
  });
  p.on('error', (err) => {
    if (game) return; // perte du serveur de mise en relation : la partie continue en WebRTC
    if (err.type === 'unavailable-id') { p.destroy(); createRoom(); return; }
    p.destroy(); peer = null;
    show('lobby');
    lobbyError('Connexion au serveur de mise en relation impossible. Réessaie dans un instant.');
  });
  p.on('connection', (c) => {
    if (conn) { c.on('open', () => c.close()); return; }
    conn = c;
    bindConn(c);
    c.on('open', () => {
      myColor = Math.random() < 0.5 ? 'w' : 'b';
      c.send({ t: 'start', color: myColor === 'w' ? 'b' : 'w', tc });
      startGame();
    });
  });
}

function joinRoom(rawCode) {
  const code = rawCode.trim().toUpperCase();
  if (code.length !== 5) { lobbyError('Le code contient 5 caractères.'); return; }
  lobbyError('');
  isHost = false;
  const p = makePeer();
  peer = p;
  let done = false;
  const fail = (msg) => {
    if (done) return; done = true;
    p.destroy(); peer = null; conn = null;
    show('lobby'); lobbyError(msg);
  };
  const timer = setTimeout(() => fail('Impossible de joindre cette room (délai dépassé).'), 12000);
  p.on('error', (err) => {
    clearTimeout(timer);
    fail(err.type === 'peer-unavailable' ? 'Room introuvable. Vérifie le code.' : 'Erreur de connexion : ' + err.type);
  });
  p.on('open', () => {
    const c = p.connect(ROOM_PREFIX + code, { reliable: true });
    conn = c;
    bindConn(c);
    c.on('open', () => { clearTimeout(timer); done = true; /* on attend le message "start" */ });
  });
}

function bindConn(c) {
  c.on('data', onMessage);
  c.on('close', () => {
    $('chat-input').disabled = true;
    if (!over && game) { over = true; setStatus("L'adversaire s'est déconnecté."); refreshBoard(); updateButtons(); }
  });
  c.on('error', () => {});
}

const send = (msg) => { if (conn && conn.open) conn.send(msg); };

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'start':
      myColor = msg.color === 'b' ? 'b' : 'w';
      tc = msg.tc && msg.tc.ms > 0 && msg.tc.inc >= 0 ? { ms: +msg.tc.ms, inc: +msg.tc.inc } : null;
      startGame();
      break;
    case 'move':
      if (!game || over || game.turn() === myColor) return;
      applyMove({ from: msg.from, to: msg.to, promotion: msg.promotion }, false, msg.left);
      break;
    case 'chat':
      addChat('Adversaire', String(msg.text).slice(0, 200));
      break;
    case 'flag':
      if (game && !over && (msg.c === 'w' || msg.c === 'b')) endOnTime(msg.c);
      break;
    case 'resign':
      if (!over) { over = true; setStatus("L'adversaire abandonne. Tu gagnes !"); finishUI(); }
      break;
    case 'rematch':
      theyWantRematch = true;
      if (iWantRematch) { rematch(); } else { setStatus("L'adversaire propose une revanche."); updateButtons(); }
      break;
  }
}

/* ---------- Partie ---------- */
function startGame() {
  show('game');
  game = new Chess();
  over = false;
  iWantRematch = false;
  theyWantRematch = false;
  positions = [{ fen: game.fen() }];
  view = 0;
  evals = [50];
  runStart = null;
  if (tc) clocks = { w: tc.ms, b: tc.ms };
  $('clock-top').hidden = $('clock-bottom').hidden = !tc;
  $('evalbar').classList.toggle('flipped', myColor === 'b');

  if (!cg) {
    cg = Chessground($('board'), {
      fen: game.fen(),
      orientation: colorName(myColor),
      coordinates: true,
      animation: { duration: 200 },
      highlight: { lastMove: true, check: true },
      premovable: { enabled: false },
      draggable: { showGhost: true },
      movable: { free: false, color: undefined, dests: new Map(), showDests: true,
        events: { after: (from, to) => onUserMove(from, to) } },
    });
  } else {
    cg.set({ orientation: colorName(myColor) });
  }
  if (!evaluator) {
    evaluator = new Evaluator(
      (cp) => {
        if (over) return;
        evals[positions.length - 1] = whitePct(cp);
        if (view === positions.length - 1) setBar(whitePct(cp));
      },
      (txt) => { $('engine-note').textContent = txt; });
    $('engine-note').textContent = 'Chargement du moteur…';
  } else {
    evaluator.stop();
  }
  refreshBoard();
  updateButtons();
  evaluator.evaluate(game.fen());
}

function legalDests() {
  const dests = new Map();
  for (const m of game.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  }
  return dests;
}

// Affiche positions[view] ; on ne peut jouer que sur la position actuelle
function refreshBoard() {
  const p = positions[view];
  const live = view === positions.length - 1;
  const myTurn = !over && game.turn() === myColor;
  const canMove = live && myTurn;
  const turn = p.fen.split(' ')[1];
  cg.set({
    fen: p.fen,
    lastMove: p.last,
    turnColor: colorName(turn),
    check: p.check ? colorName(turn) : false,
    movable: { color: canMove ? colorName(myColor) : undefined, dests: canMove ? legalDests() : new Map() },
  });
  setBar(evals.slice(0, view + 1).findLast((e) => e != null));
  renderMoves();
  tick();
  if (!over) {
    setStatus((myColor === 'w' ? 'Tu joues les Blancs' : 'Tu joues les Noirs') + ' · ' +
      (myTurn ? 'à toi de jouer' : "au tour de l'adversaire") + (live ? '' : ' · historique'));
  }
}

function renderMoves() {
  const box = $('moves');
  box.innerHTML = '';
  positions.slice(1).forEach((p, i) => {
    if (i % 2 === 0) {
      const n = document.createElement('span');
      n.className = 'num';
      n.textContent = i / 2 + 1 + '.';
      box.appendChild(n);
    }
    const b = document.createElement('button');
    b.className = 'mv' + (i + 1 === view ? ' cur' : '');
    b.textContent = p.san;
    b.onclick = () => goTo(i + 1);
    box.appendChild(b);
  });
  const cur = box.querySelector('.cur');
  if (cur) box.scrollTop = cur.offsetTop - box.clientHeight / 2;
}

function goTo(i) {
  view = Math.max(0, Math.min(positions.length - 1, i));
  cg.selectSquare(null);
  refreshBoard();
}

function setStatus(t) { $('status').textContent = t; }

function addChat(who, text) {
  const log = $('chat-log');
  const line = document.createElement('div');
  line.className = who === 'Toi' ? 'me' : '';
  const name = document.createElement('b');
  name.textContent = who + ' : ';
  line.append(name, text);
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

/* ---------- Pendules ---------- */
// ponytail: pas d'arbitre, chaque navigateur annonce son propre temps ; un client modifié peut mentir, mais sans dépasser son temps précédent + ajout
const remaining = (c) => clocks[c] - (runStart && game.turn() === c ? Date.now() - runStart : 0);

function formatClock(ms) {
  ms = Math.max(0, ms);
  if (ms < 10000) return (ms / 1000).toFixed(1);
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function tick() {
  if (!tc || !game) return;
  if (over && runStart) { clocks[game.turn()] = remaining(game.turn()); runStart = null; }
  const mine = myColor, theirs = myColor === 'w' ? 'b' : 'w';
  for (const [id, c] of [['clock-bottom', mine], ['clock-top', theirs]]) {
    const el = $(id);
    el.textContent = formatClock(remaining(c));
    el.classList.toggle('active', !!runStart && game.turn() === c);
    el.classList.toggle('low', remaining(c) < 10000);
  }
  if (!runStart) return;
  const c = game.turn();
  if (remaining(c) <= (c === myColor ? 0 : -FLAG_GRACE)) { send({ t: 'flag', c }); endOnTime(c); }
}

function endOnTime(c) {
  over = true;
  clocks[c] = 0;
  runStart = null;
  $('promo').hidden = true;
  evaluator.stop();
  const winner = c === 'w' ? 'b' : 'w';
  // ponytail: nulle seulement si le gagnant n'a que son roi, la règle FIDE complète teste tout mat possible
  const canMate = game.board().flat().some((p) => p && p.color === winner && p.type !== 'k');
  setStatus('Temps écoulé · ' + (!canMate ? 'partie nulle.' : winner === myColor ? 'tu gagnes !' : "l'adversaire gagne."));
  finishUI();
  tick();
}

function onUserMove(from, to) {
  const piece = game.get(from);
  const lastRank = to[1] === '8' || to[1] === '1';
  if (piece && piece.type === 'p' && lastRank) { askPromotion(from, to); return; }
  applyMove({ from, to }, true);
}

function askPromotion(from, to) {
  const box = $('promo');
  box.innerHTML = '';
  for (const r of ['q', 'r', 'b', 'n']) {
    const b = document.createElement('button');
    b.className = 'opt';
    const w = document.createElement('div');
    w.className = 'cg-wrap';
    const p = document.createElement('piece');
    p.className = `${{ q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }[r]} ${colorName(myColor)}`;
    w.appendChild(p); b.appendChild(w);
    b.onclick = () => { box.hidden = true; applyMove({ from, to, promotion: r }, true); };
    box.appendChild(b);
  }
  box.onclick = (e) => { if (e.target === box) { box.hidden = true; refreshBoard(); } };
  box.hidden = false;
}

function applyMove(m, mine, left) {
  if (mine) { tick(); if (over) { refreshBoard(); return; } } // temps écoulé juste avant ce coup
  const c = game.turn();
  const before = tc ? remaining(c) : 0;
  let res;
  try { res = game.move(m); } catch { res = null; }
  if (!res) { refreshBoard(); return; }
  if (tc) {
    // Les pendules démarrent après le premier coup de chaque camp (demi-coup 2)
    const plies = positions.length;
    if (plies >= 3) clocks[c] = mine ? before + tc.inc : Math.min(+left || 0, clocks[c] + tc.inc);
    runStart = plies >= 2 ? Date.now() : null;
  }
  if (mine) send({ t: 'move', from: m.from, to: m.to, promotion: m.promotion, left: clocks[c] });
  afterMove(res);
}

function afterMove(res) {
  positions.push({ fen: game.fen(), last: [res.from, res.to], san: res.san, check: game.isCheck() });
  view = positions.length - 1; // un nouveau coup ramène toujours à la position actuelle
  // Fin de partie ?
  if (game.isGameOver()) {
    over = true;
    let txt;
    if (game.isCheckmate()) {
      const whiteWins = game.turn() === 'b';
      evals[view] = whiteWins ? 100 : 0;
      txt = 'Échec et mat · ' + ((whiteWins ? 'w' : 'b') === myColor ? 'tu gagnes !' : "l'adversaire gagne.");
    } else {
      evals[view] = 50;
      txt = game.isStalemate() ? 'Pat · partie nulle.' : 'Partie nulle.';
    }
    evaluator.stop();
    refreshBoard();
    setStatus(txt);
    finishUI();
    return;
  }
  refreshBoard();
  evaluator.evaluate(game.fen());
}

function finishUI() { if (cg) cg.set({ movable: { color: undefined, dests: new Map() } }); updateButtons(); }

function updateButtons() {
  $('btn-resign').hidden = over;
  $('btn-rematch').hidden = !over || !conn || !conn.open;
  $('btn-rematch').textContent = theyWantRematch ? 'Accepter la revanche' : (iWantRematch ? 'Revanche demandée…' : 'Revanche');
  $('btn-rematch').disabled = iWantRematch && !theyWantRematch;
}

function rematch() {
  myColor = myColor === 'w' ? 'b' : 'w';
  startGame();
}

/* ---------- Événements UI ---------- */
const presets = document.querySelectorAll('.presets button');
function syncPresets() {
  for (const b of presets) b.setAttribute('aria-pressed', +b.dataset.min === +$('tc-min').value && +b.dataset.inc === +$('tc-inc').value);
}
for (const b of presets) b.onclick = () => { $('tc-min').value = b.dataset.min; $('tc-inc').value = b.dataset.inc; syncPresets(); };
$('tc-min').oninput = $('tc-inc').oninput = syncPresets;
syncPresets();
$('btn-create').onclick = createRoom;
$('join-form').onsubmit = (e) => { e.preventDefault(); joinRoom($('code-input').value); };
$('btn-cancel').onclick = () => location.assign(location.pathname);
$('btn-leave').onclick = () => location.assign(location.pathname);
$('btn-copy').onclick = async () => {
  const url = `${location.origin}${location.pathname}?room=${$('room-code').textContent}`;
  try { await navigator.clipboard.writeText(url); $('btn-copy').textContent = 'Lien copié ✓'; }
  catch { prompt('Copie ce lien :', url); }
};
$('btn-resign').onclick = () => {
  if (over || !confirm('Abandonner la partie ?')) return;
  send({ t: 'resign' });
  over = true;
  evaluator.stop();
  setStatus('Tu as abandonné.');
  finishUI();
};
$('btn-rematch').onclick = () => {
  iWantRematch = true;
  send({ t: 'rematch' });
  if (theyWantRematch) rematch(); else { setStatus('Revanche demandée…'); updateButtons(); }
};

$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text || !conn || !conn.open) return;
  send({ t: 'chat', text });
  addChat('Toi', text);
  $('chat-input').value = '';
};
$('nav-first').onclick = () => goTo(0);
$('nav-prev').onclick = () => goTo(view - 1);
$('nav-next').onclick = () => goTo(view + 1);
$('nav-last').onclick = () => goTo(positions.length - 1);
document.addEventListener('keydown', (e) => {
  if ($('game').hidden || !$('promo').hidden || e.target.tagName === 'INPUT') return;
  const to = { ArrowLeft: view - 1, ArrowRight: view + 1, ArrowUp: 0, ArrowDown: positions.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  goTo(to);
});
setInterval(tick, 100);

// Lien d'invitation ?room=CODE
const invited = new URLSearchParams(location.search).get('room');
if (invited) { $('code-input').value = invited.toUpperCase(); joinRoom(invited); }
