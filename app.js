import { Chess } from './vendor/chess.js';
import { Chessground } from './vendor/chessground/chessground.min.js';

/* ---------- Réglages ---------- */
const MIN_DEPTH = 14;   // la barre ne bouge qu'à partir de cette profondeur
const MAX_DEPTH = 17;   // profondeur maximale atteinte si on attend
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

function createRoom() {
  lobbyError('');
  isHost = true;
  const code = randomCode();
  const p = makePeer(ROOM_PREFIX + code);
  peer = p;
  p.on('open', () => {
    $('room-code').textContent = code;
    show('waiting');
  });
  p.on('error', (err) => {
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
      c.send({ t: 'start', color: myColor === 'w' ? 'b' : 'w' });
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
      startGame();
      break;
    case 'move':
      if (!game || over || game.turn() === myColor) return;
      applyMove({ from: msg.from, to: msg.to, promotion: msg.promotion }, false);
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
  $('evalbar').classList.toggle('flipped', myColor === 'b');
  setBar(50);

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
    cg.set({ orientation: colorName(myColor), lastMove: undefined });
  }
  if (!evaluator) {
    evaluator = new Evaluator(
      (cp) => { if (!over) setBar(whitePct(cp)); },
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

function refreshBoard(lastMove) {
  const myTurn = !over && game.turn() === myColor;
  const cfg = {
    fen: game.fen(),
    turnColor: colorName(game.turn()),
    check: game.isCheck() ? colorName(game.turn()) : false,
    movable: { color: myTurn ? colorName(myColor) : undefined, dests: myTurn ? legalDests() : new Map() },
  };
  if (lastMove) cfg.lastMove = lastMove;
  cg.set(cfg);
  if (!over) {
    setStatus((myColor === 'w' ? 'Tu joues les Blancs' : 'Tu joues les Noirs') + ' · ' +
      (myTurn ? 'à toi de jouer' : "au tour de l'adversaire"));
  }
}

function setStatus(t) { $('status').textContent = t; }

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

function applyMove(m, mine) {
  let res;
  try { res = game.move(m); } catch { res = null; }
  if (!res) { refreshBoard(); return; }
  if (mine) send({ t: 'move', from: m.from, to: m.to, promotion: m.promotion });
  afterMove([res.from, res.to]);
}

function afterMove(last) {
  // Fin de partie ?
  if (game.isGameOver()) {
    over = true;
    let txt;
    if (game.isCheckmate()) {
      const whiteWins = game.turn() === 'b';
      setBar(whiteWins ? 100 : 0);
      txt = 'Échec et mat · ' + ((whiteWins ? 'w' : 'b') === myColor ? 'tu gagnes !' : "l'adversaire gagne.");
    } else {
      setBar(50);
      txt = game.isStalemate() ? 'Pat · partie nulle.' : 'Partie nulle.';
    }
    evaluator.stop();
    refreshBoard(last);
    setStatus(txt);
    finishUI();
    return;
  }
  refreshBoard(last);
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

// Lien d'invitation ?room=CODE
const invited = new URLSearchParams(location.search).get('room');
if (invited) { $('code-input').value = invited.toUpperCase(); joinRoom(invited); }
