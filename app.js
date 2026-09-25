/*
 * Front v6 del sitio de revisión (GitHub Pages + backend Apps Script). Contrato: docs/DISENO-v6.md §8.
 * Todo lo visible va en inglés; los comentarios, en español. Nunca innerHTML con datos: solo el()/textContent.
 *
 * ── PÁGINAS (las genera build_web_review.py; el HTML es mínimo, app.js construye todo dentro de #app) ──
 *   index.html   <body data-page="home"><main id="app"></main><script src="config.js"></script><script src="app.js"></script>
 *   project.html <body data-page="project"> …igual…   (se abre como project.html?p=<empresa>)
 *   Ambas con <meta name="viewport" content="width=device-width,initial-scale=1">, <meta name="robots"
 *   content="noindex,nofollow"> y <link rel="stylesheet" href="app.css"> en el <head>.
 *   config.js    window.REVIEW = {"endpoint": "<URL /exec del backend>", "site": "<URL pública del sitio, con / final>"}
 *                (NUNCA la llave). `site` sirve para montar los enlaces de revisor: `${site}#k=${token}`.
 *
 * ── DATOS (los escribe build_web_review.py; rutas relativas al sitio, sin "/" inicial, sin "..", sin esquema) ──
 * data/index.json — array, una entrada por empresa publicada (no hidden; nunca la sandbox 'selftest'):
 *   [ { "id": "acme",                         // slug ^[a-z0-9-]{2,24}$ (el mismo id que usa el backend)
 *       "nombre": "Acme",
 *       "acento": "#1F6FEB",                  // "#RRGGBB" (marca.json → colores.acento o primario) o null
 *       "logo": "media/acme/logo.png",        // o null
 *       "counts": { "total": 12, "pendiente": 5, "aceptada": 4, "ajustar": 2, "rechazada": 1 } } ]
 * data/<empresa>.json — solo piezas publicables (sin hidden, sin consentimiento pendiente, sin notas_internas):
 *   { "empresa": "acme", "nombre": "Acme", "acento": "#1F6FEB" | null, "logo": "media/acme/logo.png" | null,
 *     "piezas": [ {
 *       "id": "A1",                           // ^[A-Za-z0-9_-]{1,40}$
 *       "titulo": "Spring promo — feed",
 *       "tipo": "imagen",                     // imagen|animacion|video|flyer|linkedin|impreso (del manifiesto)
 *       "semana": "Adds 09-21-2026 a 09-27-2026",
 *       "version": 2,                         // entero ≥ 1
 *       "estado_base": "pendiente",           // pendiente|aceptada|ajustar|rechazada (del manifiesto)
 *       "archivos": [ {
 *         "src": "media/acme/A1-v2-1.png",           // el original (solo para «Download»)
 *         "web": "media/acme/A1-v2-1.web.jpg",       // image: JPEG ≤1440 px · video: el MP4 · pdf/text: null
 *         "thumb": "media/acme/A1-v2-1.thumb.jpg",   // JPEG ≤540 px (en vídeo, del póster) · pdf/text: null
 *         "poster": "media/acme/A1-v2-1.poster.jpg", // solo vídeo (fotograma con ffmpeg)
 *         "formato": "4:5", "etiqueta": "Feed 4:5",
 *         "tipo": "image" } ],                       // image|video|pdf|text (pdf/text: solo descarga)
 *       "copy": { "instagram": "…", "facebook": "…", "linkedin": "…" } } ] }   // canal → texto; {} si no hay
 * Una pieza sin ninguna vista previa (ni thumb ni imagen/vídeo) se muestra sin botones (WEB-13).
 *
 * ── VISIBILIDAD (6.2, solo el dueño: admin/claude con alcance '*') ──
 * La portada añade, desde `companies`, las empresas ocultas o que aún no están en index.json (con «Hidden»).
 * La página de empresa muestra «Make visible» / «Hide» con confirmación en línea → `set_visibility`; queda
 * «Updating…» hasta que `companies` refleje el cambio (el Mac lo aplica en su siguiente pasada). Sin
 * data/<id>.json, una tarjeta de admin sustituye a «Company not found».
 */
(function () {
  'use strict';
  const CFG = window.REVIEW || {};
  const KEY_STORE = 'adreview-key';
  // Apps Script tarda a veces 30–50 s en entregar la respuesta (la capa de Google, no el script): se espera hasta 75 s.
  const POLL_MS = 30000, TIMEOUT_MS = 75000, RETRY_MS = [1500, 4000], TOAST_MS = 6000;
  const PROJECT_RE = /^[a-z0-9-]{2,24}$/;
  const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
  const MAX_NOTE = 5000;
  const TABS = [['review', 'To review'], ['ok', 'Accepted'], ['warn', 'Adjusting'], ['out', 'Rejected']];
  const BASE = { pendiente: 'review', aceptada: 'ok', ajustar: 'warn', rechazada: 'out' };
  const PILL = { review: 'To review', ok: 'Accepted', warn: 'Adjust requested', out: 'Rejected' };
  const REPLY = { working: 'Claude is working on it', final: 'Approved and saved', descartada: 'Removed by Claude' };
  const ROLE_LABEL = { claude: 'Claude', admin: 'Admin', reviewer: 'Reviewer' };
  const ERR = {
    bad_key: 'This review link is not valid any more. Ask for a new one.',
    no_key_configured: 'The review server is not set up yet. Please try again later.',
    no_endpoint: 'This site has no review server configured.',
    forbidden: 'Your link does not give access to that.',
    busy: 'The server is busy. Please try again in a moment.',
    network: 'Could not reach the review server. Check your connection.',
    server_error: 'The review server had a problem. Please try again.',
    bad_response: 'The review server gave an unexpected answer.',
    too_long: 'That text is too long (max 5000 characters).',
    bad_nota: 'Please describe what to adjust.',
    name_taken: 'An active reviewer already has that name.',
    bad_name: 'That name cannot be used.',
    bad_projects: 'Pick at least one company.',
    not_found: 'That reviewer was not found.',
  };
  const RETRYABLE = { busy: 1, server_error: 1, network: 1, bad_response: 1, use_post: 1 };  // use_post: Google convirtió el POST en GET; no se escribió nada

  // ───────── utilidades ─────────

  function errText(code) { return ERR[code] || 'Something went wrong (' + String(code || 'unknown') + ').'; }

  // Crea un nodo. attrs: text, class, on<evento>, y el resto como atributos. kids: nodos o textos.
  function el(tag, attrs, kids) {
    const n = document.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') n.textContent = String(v);
      else if (k === 'class') n.className = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (kids || []).forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  // Añade hijos saltando los vacíos (Element.append(null) escribiría "null").
  function add(n) { for (let i = 1; i < arguments.length; i++) { const c = arguments[i]; if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); } return n; }

  // localStorage con try/catch: en modo privado o con el almacenamiento bloqueado, simplemente no guarda.
  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
      return true;
    } catch (e) { return null; }
  }

  // Solo rutas relativas del propio sitio (nada de javascript:, //otro-dominio, /absolutas ni "..").
  function safeUrl(u) {
    u = typeof u === 'string' ? u.trim() : '';
    if (!u || /^[a-z][a-z0-9+.-]*:/i.test(u) || u.charAt(0) === '/' || u.indexOf('\\') >= 0 || /(^|\/)\.\.(\/|$)/.test(u)) return '';
    return u;
  }
  function safeColor(c) { return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : ''; }
  function setAccent(node, c) { if (safeColor(c)) node.style.setProperty('--accent', c); }
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  // Tipo de archivo del builder: image|video|pdf|text (se aceptan también imagen/documento).
  function kindOf(a) { const t = String(a.tipo || ''); return t === 'imagen' ? 'image' : t; }

  function ago(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return '';
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function when(iso) {
    const d = new Date(iso);
    return !iso || isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // "Adds 09-21-2026 a 09-27-2026" → {key: "2026-09-21", label: "Week of Sep 21 – Sep 27, 2026"}
  function week(s) {
    s = String(s || '');
    const m = s.match(/(\d{2})-(\d{2})-(\d{4})\D+(\d{2})-(\d{2})-(\d{4})/);
    if (!m) return { key: s ? '0-' + s : '', label: s || 'Other pieces' };
    const a = new Date(+m[3], +m[1] - 1, +m[2]), b = new Date(+m[6], +m[4] - 1, +m[5]);
    const f = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return { key: m[3] + '-' + m[1] + '-' + m[2], label: 'Week of ' + f(a) + ' – ' + f(b) + ', ' + m[6] };
  }

  // ───────── la llave del enlace (#k=…) ─────────

  let KEY = '';
  (function () {
    const m = (location.hash || '').match(/(?:^#|&)k=([A-Za-z0-9_-]+)/);
    if (m && KEY_RE.test(m[1])) {
      KEY = m[1];
      // Solo se limpia la URL si el navegador guardó la llave; si no, al recargar se perdería.
      if (store(KEY_STORE, KEY) && store(KEY_STORE) === KEY) history.replaceState(null, '', location.pathname + location.search);
    } else {
      const s = store(KEY_STORE);
      KEY = typeof s === 'string' && KEY_RE.test(s) ? s : '';
    }
  })();

  // ───────── backend ─────────

  // Un POST text/plain (sin preflight CORS). Siempre resuelve con un objeto {ok,…}.
  function api(action, body) {
    if (!CFG.endpoint) return Promise.resolve({ ok: false, error: 'no_endpoint' });
    const payload = Object.assign({}, body || {}, { key: KEY, action: action });
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, TIMEOUT_MS);
    return fetch(CFG.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload),
      cache: 'no-store', redirect: 'follow', signal: ctl ? ctl.signal : undefined,
    }).then((r) => r.json(), () => ({ ok: false, error: 'network' }))
      .catch(() => ({ ok: false, error: 'bad_response' }))
      .then((res) => { clearTimeout(timer); return isObj(res) ? res : { ok: false, error: 'bad_response' }; });
  }
  // Con reintentos para los errores pasajeros (las escrituras son idempotentes: una fila por pieza).
  function send(action, body, n) {
    n = n || 0;
    return api(action, body).then((res) => {
      if (res.ok || !RETRYABLE[res.error] || n >= RETRY_MS.length) return res;
      return new Promise((ok) => setTimeout(ok, RETRY_MS[n])).then(() => send(action, body, n + 1));
    });
  }
  function getJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }

  // ───────── armazón de la página ─────────

  const root = document.getElementById('app') || document.body.appendChild(el('div', { id: 'app' }));
  const page = document.body.getAttribute('data-page') || (/project\.html$/.test(location.pathname) ? 'project' : 'home');
  const titleEl = el('h1', { class: 'title', text: 'Ad review' });
  const logoEl = el('img', { class: 'head-logo', alt: '', hidden: true });
  const whoEl = el('span', { class: 'who' });
  const toolsEl = el('div', { class: 'tools' });
  const header = el('header', { class: 'top' }, [
    page === 'project' ? el('a', { class: 'back', href: './', text: '← Companies' }) : null,
    logoEl, titleEl, el('div', { class: 'spacer' }), whoEl, toolsEl,
  ]);
  const main = el(root.tagName === 'MAIN' ? 'div' : 'main', { class: 'main' });
  const adminBar = el('div', { class: 'admin-bar', hidden: true });   // visibilidad (solo el dueño); renderProject no la toca
  const toasts = el('div', { class: 'toasts', 'aria-live': 'polite' });
  root.appendChild(el('div', { class: 'wrap' }, [header, adminBar, main]));
  root.appendChild(toasts);

  function toast(msg, kind) {
    const t = el('div', { class: 'toast' + (kind ? ' ' + kind : ''), role: kind === 'error' ? 'alert' : 'status', text: msg });
    toasts.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, TOAST_MS);
  }
  function message(title, text) {
    clear(main).appendChild(el('div', { class: 'empty big' }, [el('h2', { text: title }), text ? el('p', { text: text }) : null]));
  }

  // Un <dialog> reutilizable (con respaldo si el navegador no tiene showModal).
  function makeDialog(cls, label) {
    const d = el('dialog', { class: 'dlg ' + cls, 'aria-label': label });
    d.addEventListener('click', (e) => { if (e.target === d) closeDialog(d); });  // clic fuera = cerrar
    document.body.appendChild(d);
    return d;
  }
  function openDialog(d) { if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); }
  function closeDialog(d) { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); }

  let me = null;
  const ME_STORE = 'adreview.me';

  function parseMe(res) {
    return { name: String(res.name || ''), role: String(res.role || ''), projects: res.projects === '*' ? '*' : (Array.isArray(res.projects) ? res.projects : []),
      canManage: res.can_manage === undefined ? (res.role === 'admin' || res.role === 'claude') : !!res.can_manage };
  }
  // Apps Script puede tardar de 2 a 30 s en contestar: la identidad se recuerda por llave para pintar al
  // instante, y se revalida en segundo plano (si la llave ya no vale, se olvida y se avisa).
  function cachedMe() {
    try { const c = JSON.parse(store(ME_STORE) || 'null'); return isObj(c) && c.key === KEY && isObj(c.me) ? c.me : null; } catch (e) { return null; }
  }
  function start(m) {
    me = m;
    whoEl.textContent = 'Reviewing as ' + me.name;
    toolsEl.appendChild(el('button', { class: 'btn ghost small', type: 'button', text: 'Forget link', title: 'Remove the access key from this browser',
      onclick: () => { store(KEY_STORE, null); store(ME_STORE, null); location.replace(location.pathname + location.search); } }));
    if (page === 'project') projectPage(); else homePage();
  }
  function boot() {
    if (!KEY) return message('Open your review link', 'This site only works from the private review link you were sent. Open that link again (it contains your access key).');
    if (!CFG.endpoint) return message('Not configured', errText('no_endpoint'));
    const cached = cachedMe();
    if (cached) start(cached); else message('Loading…', 'Connecting to the review service. The first load can take a few seconds.');
    (cached ? api('me') : send('me')).then((res) => {
      if (!res.ok) {
        if (res.error === 'bad_key') { store(KEY_STORE, null); store(ME_STORE, null); return message('Link not valid', errText('bad_key')); }
        // Con la identidad recordada, un fallo pasajero de Apps Script no molesta: se revalida en la próxima visita.
        if (cached) return RETRYABLE[res.error] ? null : toast(errText(res.error), 'error');
        return message('Cannot connect', errText(res.error));
      }
      const fresh = parseMe(res);
      store(ME_STORE, JSON.stringify({ key: KEY, me: fresh }));
      if (!cached) return start(fresh);
      // Si el alcance o el rol cambiaron desde la última visita, se recarga con los datos nuevos.
      if (JSON.stringify(fresh) !== JSON.stringify(cached)) location.reload();
    });
  }
  function inScope(id) { return me.projects === '*' || me.projects.indexOf(id) >= 0; }
  // El dueño: admin o claude con alcance total (el backend lo vuelve a exigir en cada acción).
  function isOwner() { return !!me && (me.role === 'admin' || me.role === 'claude') && me.projects === '*'; }

  // ───────── portada ─────────

  let companies = [];

  function homePage() {
    document.title = 'Ad review';
    if (me.canManage) toolsEl.insertBefore(el('button', { class: 'btn small', type: 'button', text: 'Reviewers', onclick: openReviewers }), toolsEl.firstChild);
    // «New company» solo para el dueño: admin/claude con alcance total (el backend lo vuelve a comprobar).
    if (isOwner()) {
      toolsEl.insertBefore(el('button', { class: 'btn small', type: 'button', text: 'New company', onclick: openNewCompany }), toolsEl.firstChild);
    }
    getJSON('data/index.json').then((idx) => {
      const list = Array.isArray(idx) ? idx : (isObj(idx) && Array.isArray(idx.empresas) ? idx.empresas : []);
      companies = list.filter((c) => isObj(c) && PROJECT_RE.test(String(c.id)) && inScope(String(c.id)));
      renderHome();
      // El dueño ve además las empresas ocultas o aún sin publicar (las que el Mac anuncia en `companies`).
      if (isOwner()) {
        send('companies').then((res) => {
          if (!res.ok) { if (res.error !== 'bad_action' && !RETRYABLE[res.error]) toast('Cannot load hidden companies: ' + errText(res.error), 'error'); return; }
          known = parseCompanies(res);
          renderHome();
        });
      }
    });
  }

  let known = [];   // [{id, nombre, hidden, pending_hidden}] de `companies` (solo el dueño)

  function parseCompanies(res) {
    return (Array.isArray(res.companies) ? res.companies : []).filter((k) => isObj(k) && PROJECT_RE.test(String(k.id)))
      .map((k) => ({ id: String(k.id), nombre: String(k.nombre || k.id), hidden: k.hidden === true,
        pending_hidden: typeof k.pending_hidden === 'boolean' ? k.pending_hidden : null }));
  }
  function knownOf(id) { return known.find((k) => k.id === id) || null; }

  function renderHome() {
    // Las publicadas llevan su etiqueta desde knownOf; aquí solo las que no están en index.json.
    const extraCards = known.filter((k) => !companies.some((c) => c.id === k.id));
    if (!companies.length && !extraCards.length) return message('No companies yet', 'There is nothing for you to review right now.');
    clear(main);
    main.appendChild(el('p', { class: 'lead', text: 'Pick a company. Accept, adjust or reject each piece; Claude picks up your decisions every few minutes.' }));
    main.appendChild(el('div', { class: 'cards' }, companies.map((c) => companyCard(c, knownOf(c.id)))
      .concat(extraCards.map((k) => companyCard({ id: k.id, nombre: k.nombre }, k, true)))));
  }

  // k: la entrada de `companies` (solo el dueño) o null. unpublished: no está en index.json.
  function companyCard(c, k, unpublished) {
    const n = isObj(c.counts) ? c.counts : {};
    const total = Number(n.total) || 0, todo = Number(n.pendiente) || 0;
    const logo = safeUrl(c.logo);
    let tag = null;
    if (k && k.pending_hidden !== null) tag = el('span', { class: 'pill p-warn', text: 'Updating…' });
    else if (k && k.hidden) tag = el('span', { class: 'pill p-hidden', text: 'Hidden' });
    else if (unpublished) tag = el('span', { class: 'pill p-review', text: 'Publishing…' });
    const a = el('a', { class: 'company' + (k && k.hidden ? ' is-hidden' : ''), href: 'project.html?p=' + encodeURIComponent(c.id) }, [
      el('div', { class: 'company-logo' }, [logo ? el('img', { src: logo, alt: '', loading: 'lazy' }) : el('span', { text: String(c.nombre || c.id).slice(0, 2).toUpperCase() })]),
      el('div', { class: 'company-body' }, [
        el('h2', { text: String(c.nombre || c.id) }),
        tag ? el('div', { class: 'badges' }, [tag]) : null,
        el('p', { class: 'muted', text: unpublished ? (k && k.hidden ? 'Only you can see it. Reviewers cannot.' : 'Not on the site yet.')
          : total + (total === 1 ? ' piece' : ' pieces') + (todo ? ' · ' + todo + ' to review' : '') }),
      ]),
    ]);
    setAccent(a, c.acento);
    return a;
  }

  // ───────── página de empresa ─────────

  const P = { synced: false, id: '', data: null, pieces: [], remote: {}, rev: '', lastCheck: '', tab: 'review', sel: new Set(), pending: {}, polling: false, dead: false };

  function projectPage() {
    const q = new URLSearchParams(location.search).get('p') || '';
    if (!PROJECT_RE.test(q)) return message('Company not found', 'This link does not point to a company.');
    if (!inScope(q)) return message('No access', 'Your review link does not include this company.');
    P.id = q;
    // Las piezas salen del JSON estático al momento; las decisiones llegan del backend cuando conteste.
    getJSON('data/' + q + '.json').then((data) => {
      if (!isObj(data) || !Array.isArray(data.piezas)) {
        if (isOwner()) return adminCompanyPage(q);   // oculta o sin piezas: el dueño ve su tarjeta de admin
        return message('Company not found', 'There are no pieces published for this company yet.');
      }
      P.data = data;
      if (isOwner()) { adminBar.hidden = false; adminBar.appendChild(V.box); adminBar.appendChild(J.box); renderVis(); loadVisibility(); renderJobs(); loadJobs(); }
      P.pieces = data.piezas.filter((p) => isObj(p) && /^[A-Za-z0-9_-]{1,40}$/.test(String(p.id)));
      titleEl.textContent = String(data.nombre || q);
      document.title = String(data.nombre || q) + ' · Ad review';
      const logo = safeUrl(data.logo);
      if (logo) { logoEl.src = logo; logoEl.hidden = false; }
      setAccent(document.documentElement, data.acento);
      renderProject();
      send('read', { projects: [q] }).then((res) => {
        P.synced = true;
        if (!res.ok) { renderProject(); return toast('Cannot load decisions: ' + errText(res.error), 'error'); }
        applyRead(res);
        const firstTab = TABS.find((t) => counts()[t[0]]);
        if (!counts()[P.tab] && firstTab) P.tab = firstTab[0];
        renderProject();
        setInterval(poll, POLL_MS);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
      });
    });
  }

  // ───────── visibilidad de la empresa (solo el dueño) ─────────

  const V = { box: el('div', { class: 'vis', 'aria-live': 'polite' }), info: null, confirm: false, target: null, timer: null, loading: false, listening: false, err: '' };
  const VIS_ERR = {
    unknown_project: 'The Mac has not reported this company yet. Try again in a few minutes.',
    too_many: 'Too many changes are waiting. Try again in a few minutes.',
    forbidden: 'Only the owner can change who sees a company.',
    bad_action: 'The review server needs to be updated before companies can be hidden or shown here.',
  };

  function visUpdating() { return V.target !== null || (V.info && V.info.pending_hidden !== null); }

  // Lee `companies` y actualiza el estado de esta empresa. Resuelve con la entrada o null.
  function loadVisibility(quiet) {
    if (V.loading) return Promise.resolve(V.info);
    V.loading = true;
    return (quiet ? api : send)('companies').then((res) => {
      V.loading = false;
      if (!res.ok) {
        if (!(quiet && RETRYABLE[res.error])) { V.err = VIS_ERR[res.error] || errText(res.error); renderVis(); }
        return V.info;
      }
      V.err = '';
      known = parseCompanies(res);
      const prev = V.info;
      V.info = knownOf(P.id);
      if (V.target !== null && V.info && V.info.pending_hidden === null) {
        // Ya no hay nada pendiente: o se aplicó, o el Mac no pudo aplicarlo.
        if (V.info.hidden === V.target) toast(V.target ? 'The company is hidden now.' : 'The company is visible now. The site updates in a minute or two.', 'ok');
        else if (prev) toast('The Mac could not apply the change. Check the service on the Mac.', 'error');
        V.target = null;
      }
      renderVis();
      visPolling();
      return V.info;
    });
  }

  // Sondeo de `companies` cada 20 s solo mientras hay un cambio pendiente (y con la pestaña visible).
  function visPolling() {
    if (!V.listening) {   // al volver a la pestaña con un cambio pendiente, se comprueba en seguida
      V.listening = true;
      document.addEventListener('visibilitychange', () => { if (!document.hidden && visUpdating()) loadVisibility(true); });
    }
    if (visUpdating() && !V.timer) V.timer = setInterval(() => { if (!document.hidden) loadVisibility(true); }, POLL_MS);
    if (!visUpdating() && V.timer) { clearInterval(V.timer); V.timer = null; }
  }

  function setVisibility(hidden, btn) {
    btn.disabled = true;
    send('set_visibility', { project: P.id, hidden: hidden }).then((res) => {
      V.confirm = false;
      if (!res.ok) { btn.disabled = false; V.err = VIS_ERR[res.error] || errText(res.error); renderVis(); return; }
      V.err = '';
      if (res.noop) { V.target = null; loadVisibility(true); return; }
      V.target = hidden;
      if (V.info) V.info.pending_hidden = hidden;
      renderVis();
      visPolling();
    });
  }

  function renderVis() {
    const box = clear(V.box), k = V.info;
    if (!k) {
      add(box, el('p', { class: V.err ? 'form-err' : 'muted small', text: V.err || 'Loading visibility…' }));
      return;
    }
    const hidden = k.hidden;
    add(box, el('div', { class: 'row tight' }, [
      el('span', { class: 'muted small', text: 'Visibility:' }),
      el('span', { class: 'pill ' + (hidden ? 'p-hidden' : 'p-ok'), text: hidden ? 'Hidden' : 'Visible' }),
    ]));
    if (visUpdating()) {
      add(box, el('p', { class: 'muted small vis-wait', text: 'Updating… (the Mac applies it within ~2 minutes)' }));
    } else if (V.confirm) {
      add(box, el('div', { class: 'row tight' }, [
        el('span', { class: 'confirm', text: hidden ? 'Make this company visible to its reviewers?' : 'Hide this company? Reviewers will no longer see it.' }),
        el('button', { class: 'btn small' + (hidden ? '' : ' out'), type: 'button', text: hidden ? 'Yes, make visible' : 'Yes, hide', onclick: (e) => setVisibility(!hidden, e.target) }),
        el('button', { class: 'btn ghost small', type: 'button', text: 'Cancel', onclick: () => { V.confirm = false; renderVis(); } }),
      ]));
    } else {
      add(box, el('button', { class: 'btn small' + (hidden ? '' : ' ghost'), type: 'button', text: hidden ? 'Make visible' : 'Hide',
        onclick: () => { V.confirm = true; V.err = ''; renderVis(); } }));
    }
    if (V.err) add(box, el('p', { class: 'form-err small', role: 'alert', text: V.err }));
  }

  // Empresa sin data/<id>.json (oculta o sin piezas publicadas): tarjeta de admin en vez de «Company not found».
  function adminCompanyPage(q) {
    P.id = q;
    message('Loading…', 'Checking this company with the review service.');
    loadVisibility().then((k) => {
      if (!k) return message('Company not found', V.err || 'There are no pieces published for this company yet.');
      titleEl.textContent = k.nombre;
      document.title = k.nombre + ' · Ad review';
      clear(main).appendChild(el('section', { class: 'admin-card' }, [
        el('h2', { text: k.nombre }),
        el('p', { class: 'muted small', text: q + ' · 0 pieces on the review site' }),
        V.box,
        el('p', { class: 'small', text: 'Use “Set up brand” so Claude prepares the brand from the website, then “Create pieces”. They appear here for review.' }),
        J.box,
      ]));
      renderVis();
      renderJobs();
      loadJobs();
    });
  }

  function applyRead(res) {
    P.rev = String(res.rev || '');
    if (res.unchanged) return false;
    const d = isObj(res.data) && isObj(res.data[P.id]) ? res.data[P.id] : {};
    const fresh = isObj(d.pieces) ? d.pieces : {};
    Object.keys(P.pending).forEach((id) => { fresh[id] = P.remote[id]; });  // lo que aún se está enviando manda
    P.remote = fresh;
    P.lastCheck = String(d.last_check || '');
    return true;
  }

  // Sondeo: read + since cada 20 s; nada con la pestaña oculta.
  function poll() {
    if (document.hidden || P.polling || P.dead) return;
    P.polling = true;
    api('read', { projects: [P.id], since: P.rev }).then((res) => {
      P.polling = false;
      if (!res.ok) {
        if (res.error === 'bad_key' || res.error === 'forbidden') { P.dead = true; toast(errText(res.error), 'error'); }
        return;
      }
      if (applyRead(res)) { renderProject(); refreshModal(); }
    });
  }

  function previewOf(p) {
    const files = Array.isArray(p.archivos) ? p.archivos.filter(isObj) : [];
    for (const a of files) {
      const k = kindOf(a);
      const img = k === 'video' ? safeUrl(a.poster) || safeUrl(a.thumb) : safeUrl(a.thumb) || (k === 'image' ? safeUrl(a.web) || safeUrl(a.src) : '');
      if (img) return { img: img, video: k === 'video' };
      if (k === 'video' && (safeUrl(a.web) || safeUrl(a.src))) return { img: '', video: true };
    }
    return null;
  }
  const hasMedia = (p) => !!previewOf(p);

  // Estado efectivo: la decisión del backend manda; sin decisión, una versión rehecha vuelve a «To review»;
  // si no, el estado del manifiesto.
  function stateOf(p) {
    const r = isObj(P.remote[p.id]) ? P.remote[p.id] : {};
    const reply = isObj(r.reply) ? r.reply : null;
    const decided = r.estado === 'ok' || r.estado === 'warn' || r.estado === 'out';
    let bucket;
    if (decided) bucket = r.estado;
    else if (reply && reply.tipo === 'rehecha') bucket = 'review';
    else bucket = BASE[p.estado_base] || 'review';
    let note = '', kind = 'wait';
    if (reply && (reply.tipo === 'rehecha' ? !decided : decided && reply.decision_t === r.t)) {
      note = reply.tipo === 'rehecha' ? 'New version v' + (Number(reply.version) || p.version) + ' — please review' : REPLY[reply.tipo] || '';
      kind = reply.tipo;
    } else if (decided) note = P.pending[p.id] ? 'Saving…' : (r.estado === 'warn' && remakeOpen(p.id) ? 'Claude is remaking this…' : 'Waiting for Claude');
    return { bucket: bucket, decision: decided ? r : null, reply: reply, note: note, kind: kind };
  }

  function counts() {
    const c = { review: 0, ok: 0, warn: 0, out: 0 };
    P.pieces.forEach((p) => { c[stateOf(p).bucket]++; });
    return c;
  }

  function renderProject() {
    const c = counts();
    const tabs = el('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Filter by status' }, TABS.map((t) => el('button', {
      class: 'tab' + (P.tab === t[0] ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': P.tab === t[0] ? 'true' : 'false',
      onclick: () => { P.tab = t[0]; P.sel.clear(); renderProject(); },
    }, [t[1] + ' ', el('span', { class: 'count', text: String(c[t[0]]) })])));
    const status = el('p', { class: 'status muted', text: !P.synced ? 'Syncing decisions…' : P.lastCheck ? 'Claude last checked ' + ago(P.lastCheck) + '.' : 'Claude has not checked this company yet.' });
    const shown = P.pieces.filter((p) => stateOf(p).bucket === P.tab);
    [...P.sel].forEach((id) => { if (!shown.some((p) => p.id === id && canSelect(p))) P.sel.delete(id); });
    const weeks = {};
    shown.forEach((p) => { const w = week(p.semana); (weeks[w.key] = weeks[w.key] || { label: w.label, items: [] }).items.push(p); });
    const body = el('div', { class: 'weeks' });
    Object.keys(weeks).sort().reverse().forEach((k) => {
      const w = weeks[k];
      w.items.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
      body.appendChild(el('section', { class: 'week' }, [el('h2', { class: 'week-title', text: w.label }), el('div', { class: 'grid' }, w.items.map(card))]));
    });
    if (!shown.length) body.appendChild(el('div', { class: 'empty', text: P.tab === 'review' ? 'Nothing left to review. Thank you!' : 'No pieces here.' }));
    add(clear(main), tabs, status, body, bulkBar());
  }

  const canSelect = (p) => hasMedia(p) && stateOf(p).bucket === 'review' && !P.pending[p.id];

  function card(p) {
    const st = stateOf(p), pv = previewOf(p);
    const media = pv
      ? el('div', { class: 'thumb' }, [pv.img ? el('img', { src: pv.img, alt: String(p.titulo || p.id), loading: 'lazy' }) : el('span', { class: 'noprev', text: 'Video' }),
        pv.video ? el('span', { class: 'play', 'aria-hidden': 'true', text: '▶' }) : null])
      : el('div', { class: 'thumb none' }, [el('span', { class: 'noprev', text: 'No preview available' })]);
    const first = (Array.isArray(p.archivos) ? p.archivos : []).filter(isObj)[0] || {};
    const node = el('article', { class: 'card st-' + st.bucket + (P.sel.has(p.id) ? ' selected' : '') }, [
      el('button', { class: 'card-open', type: 'button', 'aria-label': 'Open ' + String(p.titulo || p.id), onclick: () => openModal(p.id) }, [media]),
      el('div', { class: 'card-body' }, [
        el('h3', { class: 'card-title', text: String(p.titulo || p.id) }),
        el('p', { class: 'meta', text: [p.id, 'v' + (Number(p.version) || 1), first.etiqueta || first.formato || ''].filter(Boolean).join(' · ') }),
        el('div', { class: 'badges' }, [el('span', { class: 'pill p-' + st.bucket, text: PILL[st.bucket] }),
          st.note ? el('span', { class: 'reply r-' + st.kind, text: st.note }) : null]),
      ]),
    ]);
    if (canSelect(p)) {
      node.appendChild(el('label', { class: 'pick', title: 'Select for bulk accept' }, [el('input', {
        type: 'checkbox', checked: P.sel.has(p.id), 'aria-label': 'Select ' + String(p.titulo || p.id),
        onchange: (e) => { if (e.target.checked) P.sel.add(p.id); else P.sel.delete(p.id); renderProject(); },
      })]));
    }
    return node;
  }

  function bulkBar() {
    if (P.tab !== 'review') return null;
    const selectable = P.pieces.filter((p) => stateOf(p).bucket === 'review' && canSelect(p));
    if (!selectable.length) return null;
    const n = P.sel.size;
    return el('div', { class: 'bulk' + (n ? ' on' : '') }, [
      el('span', { text: n ? n + ' selected' : 'Select pieces to accept them together' }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn ghost small', type: 'button', text: n === selectable.length ? 'Clear' : 'Select all',
        onclick: () => { if (n === selectable.length) P.sel.clear(); else selectable.forEach((p) => P.sel.add(p.id)); renderProject(); } }),
      n ? el('button', { class: 'btn ok', type: 'button', text: 'Accept ' + n, onclick: bulkAccept }) : null,
    ]);
  }

  function bulkAccept() {
    const ids = [...P.sel];
    P.sel.clear();
    let failed = 0;
    // Una tras otra: el backend toma un lock por escritura, así no se atascan.
    ids.reduce((chain, id) => chain.then(() => {
      const p = P.pieces.find((x) => x.id === id);
      return p ? decide(p, 'ok', '', true).then((ok) => { if (!ok) failed++; }) : null;
    }), Promise.resolve()).then(() => {
      toast(failed ? (ids.length - failed) + ' accepted, ' + failed + ' failed. Try those again.' : ids.length + (ids.length === 1 ? ' piece' : ' pieces') + ' accepted.', failed ? 'error' : 'ok');
    });
  }

  // Envía una decisión con actualización optimista; resuelve true/false.
  function decide(p, estado, nota, quiet) {
    const prev = P.remote[p.id];
    P.pending[p.id] = true;
    P.remote[p.id] = Object.assign({}, isObj(prev) ? prev : {}, { estado: estado, nota: nota, who: me.name, t: 'pending' });
    renderProject(); refreshModal();
    return send('decision', { project: P.id, id: p.id, estado: estado, nota: nota, extra: { version: Number(p.version) || 1 } }).then((res) => {
      delete P.pending[p.id];
      if (res.ok) {
        P.remote[p.id].t = String(res.t || '');
        if (!quiet) toast(estado === 'ok' ? 'Accepted.' : estado === 'warn' ? 'Adjustment sent to Claude.' : 'Rejected.', 'ok');
      } else {
        P.remote[p.id] = prev;
        toast('Not saved: ' + errText(res.error), 'error');
      }
      renderProject(); refreshModal();
      return !!res.ok;
    });
  }

  // ───────── trabajos de Claude (solo el dueño, 6.3) ─────────

  const J = { box: el('div', { class: 'jobs', 'aria-live': 'polite' }), jobs: [], form: '', draft: '', err: '', timer: null, loading: false, loaded: false };
  const JOB_LABEL = { setup: 'Set up brand', create: 'Create pieces', remake: 'Remake' };
  const JOB_STATUS = { queued: 'Waiting', running: 'Working…', done: 'Done', failed: 'Failed' };
  const JOB_ERR = {
    unknown_project: 'The Mac has not reported this company yet. Try again in a few minutes.',
    too_many: 'Claude already has 5 jobs waiting. Try again when some finish.',
    no_adjust: 'This piece no longer has an adjustment to remake.',
    bad_brief: 'Describe what Claude should create.',
    forbidden: 'Only the owner can ask Claude to work.',
    bad_action: 'The review server needs to be updated before Claude can work from here.',
  };
  function jobErr(code) { return JOB_ERR[code] || errText(code); }
  function jobOpen(j) { return j.status === 'queued' || j.status === 'running'; }
  function remakeOpen(pid) { return J.jobs.some((j) => j.kind === 'remake' && j.piece === pid && jobOpen(j)); }

  function loadJobs(quiet) {
    if (J.loading || !isOwner()) return Promise.resolve();
    J.loading = true;
    return (quiet ? api : send)('jobs', { project: P.id }).then((res) => {
      J.loading = false;
      if (!res.ok) { if (!(quiet && RETRYABLE[res.error])) { J.err = jobErr(res.error); renderJobs(); } return; }
      const before = J.jobs.filter(jobOpen).map((j) => j.id);
      J.jobs = (Array.isArray(res.jobs) ? res.jobs : []).filter(isObj);
      J.err = ''; J.loaded = true;
      J.jobs.forEach((j) => { if (before.indexOf(j.id) >= 0 && !jobOpen(j)) toast(JOB_LABEL[j.kind] + (j.status === 'done' ? ' finished.' : ' failed.'), j.status === 'done' ? 'ok' : 'error'); });
      renderJobs();
      if (P.data) { renderProject(); refreshModal(); }
      const busy = J.jobs.some(jobOpen);
      if (busy && !J.timer) J.timer = setInterval(() => { if (!document.hidden) loadJobs(true); }, 15000);
      if (!busy && J.timer) { clearInterval(J.timer); J.timer = null; }
    });
  }

  function requestJob(kind, brief, piece) {
    const body = { project: P.id, kind: kind, brief: brief || '' };
    if (piece) body.piece = piece;
    return send('job_request', body).then((res) => {
      if (res.ok) { toast(res.duplicate ? 'Claude already has that job.' : 'Queued for Claude. The Mac works on one Claude job at a time, so this one may wait for others to finish.', 'ok'); loadJobs(true); }
      return res;
    });
  }

  function renderJobs() {
    const box = clear(J.box);
    add(box, el('h3', { class: 'jobs-title', text: 'Claude' }));
    if (J.form) {
      const create = J.form === 'create';
      const ta = el('textarea', { rows: 4, maxlength: 2000, 'aria-label': create ? 'Brief' : 'Notes',
        placeholder: create ? 'What should Claude create? e.g. “3 Instagram posts (4:5) about our winter promo”' : 'Notes for Claude (optional): website, what to emphasize…',
        oninput: (e) => { J.draft = e.target.value; } });
      ta.value = J.draft;
      const errEl = el('p', { class: 'form-err', role: 'alert', text: J.err });
      add(box, ta, errEl, el('div', { class: 'row tight' }, [
        el('button', { class: 'btn small', type: 'button', text: create ? 'Create pieces' : 'Set up brand', onclick: (e) => {
          const t = J.draft.trim();
          if (create && !t) { errEl.textContent = jobErr('bad_brief'); ta.focus(); return; }
          e.target.disabled = true;
          requestJob(J.form, t).then((res) => {
            if (!res.ok) { e.target.disabled = false; J.err = jobErr(res.error); renderJobs(); return; }
            J.form = ''; J.draft = ''; J.err = ''; renderJobs();
          });
        } }),
        el('button', { class: 'btn ghost small', type: 'button', text: 'Cancel', onclick: () => { J.form = ''; J.err = ''; renderJobs(); } }),
      ]));
      setTimeout(() => ta.focus(), 0);
    } else {
      add(box, el('div', { class: 'row tight' }, [
        el('button', { class: 'btn small', type: 'button', text: 'Create pieces', onclick: () => { J.form = 'create'; J.draft = ''; renderJobs(); } }),
        el('button', { class: 'btn ghost small', type: 'button', text: 'Set up brand', onclick: () => { J.form = 'setup'; J.draft = ''; renderJobs(); } }),
      ]));
      if (J.err) add(box, el('p', { class: 'form-err small', role: 'alert', text: J.err }));
    }
    const recent = J.jobs.slice(0, 6);
    if (recent.length) {
      add(box, el('ul', { class: 'job-list' }, recent.map((j) => el('li', { class: 'job j-' + j.status }, [
        el('div', { class: 'row tight' }, [
          el('strong', { text: JOB_LABEL[j.kind] + (j.piece ? ' ' + j.piece : '') }),
          el('span', { class: 'pill j-' + j.status, text: JOB_STATUS[j.status] || j.status }),
          el('span', { class: 'muted small', text: ago(j.t) }),
        ]),
        j.note ? el('p', { class: 'small job-note', text: j.note }) : (j.brief ? el('p', { class: 'muted small job-note', text: j.brief }) : null),
      ]))));
    } else if (J.loaded) add(box, el('p', { class: 'muted small', text: 'No Claude jobs yet for this company.' }));
  }

  // ───────── ficha (modal) ─────────

  const M = { dlg: null, id: '', file: 0, form: '', draft: '', statusBox: null, actionsBox: null };

  function visible() { return P.pieces.filter((p) => stateOf(p).bucket === P.tab); }

  function openModal(id) {
    if (!M.dlg) {
      M.dlg = makeDialog('piece', 'Piece details');
      M.dlg.addEventListener('keydown', (e) => {
        if (e.target && /^(TEXTAREA|INPUT)$/.test(e.target.tagName)) return;
        if (e.key === 'ArrowRight') step(1); else if (e.key === 'ArrowLeft') step(-1);
      });
      // El evento close llega asíncrono: si ya se volvió a abrir, no se toca nada.
      M.dlg.addEventListener('close', () => { if (!M.dlg.open) { M.id = ''; clear(M.dlg); } });
    }
    if (M.id !== id) { M.file = 0; M.form = ''; M.draft = ''; }
    M.id = id;
    renderModal();
    openDialog(M.dlg);
  }
  function step(d) {
    const list = visible(), i = list.findIndex((p) => p.id === M.id);
    if (!list.length) return;
    openModal(list[i < 0 ? 0 : (i + d + list.length) % list.length].id);
  }
  // Decide desde la ficha y pasa a la siguiente pieza de la misma pestaña (o cierra si no quedan).
  function decideAndNext(p, estado, nota) {
    const list = visible().filter((x) => x.id === p.id || hasMedia(x));
    const i = list.findIndex((x) => x.id === p.id);
    const next = list.length > 1 && i >= 0 ? list[(i + 1) % list.length] : null;
    decide(p, estado, nota);
    if (next && next.id !== p.id && P.tab === 'review') openModal(next.id); else closeDialog(M.dlg);
  }

  function renderModal() {
    const p = P.pieces.find((x) => x.id === M.id);
    if (!p || !M.dlg) return;
    const files = (Array.isArray(p.archivos) ? p.archivos : []).filter(isObj);
    const f = files[M.file] || files[0] || null;
    const viewer = el('div', { class: 'viewer' });
    if (f) {
      const src = safeUrl(f.web) || safeUrl(f.src);
      if (kindOf(f) === 'video' && src) viewer.appendChild(el('video', { src: src, poster: safeUrl(f.poster) || safeUrl(f.thumb) || null, controls: true, playsinline: true, preload: 'metadata' }));
      else if (kindOf(f) === 'image' && src) viewer.appendChild(el('img', { src: src, alt: String(p.titulo || p.id) }));
      else if (safeUrl(f.thumb)) viewer.appendChild(el('img', { src: safeUrl(f.thumb), alt: String(p.titulo || p.id) }));
      else viewer.appendChild(el('p', { class: 'noprev', text: 'No preview available. Use Download to open the file.' }));
    } else viewer.appendChild(el('p', { class: 'noprev', text: 'No preview available.' }));
    const fileTabs = files.length > 1 ? el('div', { class: 'filetabs' }, files.map((x, i) => el('button', {
      class: 'chip' + (i === M.file ? ' on' : ''), type: 'button', text: String(x.etiqueta || x.formato || 'File ' + (i + 1)),
      onclick: () => { M.file = i; renderModal(); },
    }))) : null;
    const orig = f ? safeUrl(f.src) : '';
    const ext = (orig.match(/\.([A-Za-z0-9]{1,5})$/) || [])[1] || 'file';
    const dl = orig ? el('a', { class: 'btn ghost small', href: orig, download: [P.id, p.id, 'v' + (Number(p.version) || 1), String(f.formato || '').replace(/[^0-9A-Za-z]+/g, 'x')].filter(Boolean).join('-') + '.' + ext, text: 'Download original' }) : null;
    const copy = isObj(p.copy) ? Object.keys(p.copy).filter((k) => typeof p.copy[k] === 'string' && p.copy[k].trim()) : [];
    const copyBox = copy.length ? el('section', { class: 'copy' }, [el('h3', { text: 'Ad copy' })].concat(copy.map((k) =>
      el('div', { class: 'copy-item' }, [el('h4', { text: k.charAt(0).toUpperCase() + k.slice(1) }), el('p', { text: p.copy[k] })])))) : null;
    M.statusBox = el('div', { class: 'status-box' });
    M.actionsBox = el('div', { class: 'actions' });
    clear(M.dlg).appendChild(el('div', { class: 'dlg-inner' }, [
      el('header', { class: 'dlg-head' }, [
        el('div', {}, [el('h2', { text: String(p.titulo || p.id) }), el('p', { class: 'meta', text: p.id + ' · version ' + (Number(p.version) || 1) })]),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn ghost small', type: 'button', text: '‹', 'aria-label': 'Previous piece', onclick: () => step(-1) }),
        el('button', { class: 'btn ghost small', type: 'button', text: '›', 'aria-label': 'Next piece', onclick: () => step(1) }),
        el('button', { class: 'btn ghost small', type: 'button', text: 'Close', onclick: () => closeDialog(M.dlg) }),
      ]),
      el('div', { class: 'dlg-body' }, [
        el('div', { class: 'dlg-media' }, [viewer, el('div', { class: 'filebar' }, [fileTabs, dl])]),
        el('div', { class: 'dlg-side' }, [M.statusBox, M.actionsBox, copyBox]),
      ]),
    ]));
    fillStatus(p);
    fillActions(p);
  }

  // Tras un sondeo: se rehacen el estado y (si no hay un formulario abierto) los botones; el vídeo sigue.
  function refreshModal() {
    if (!M.id || !M.dlg || !M.statusBox) return;
    const p = P.pieces.find((x) => x.id === M.id);
    if (!p) return;
    fillStatus(p);
    if (!M.form) fillActions(p);
  }

  function fillStatus(p) {
    const st = stateOf(p), d = st.decision;
    add(clear(M.statusBox),
      el('div', { class: 'badges' }, [el('span', { class: 'pill p-' + st.bucket, text: PILL[st.bucket] }),
        st.note ? el('span', { class: 'reply r-' + st.kind, text: st.note }) : null]),
      d && d.who ? el('p', { class: 'muted', text: 'By ' + d.who + (when(d.t) ? ' · ' + when(d.t) : '') }) : null,
      d && d.nota ? el('blockquote', { class: 'note', text: d.nota }) : null,
      st.kind !== 'wait' && st.reply.mensaje ? el('p', { class: 'claude-msg', text: 'Claude: ' + st.reply.mensaje }) : null);
  }

  function fillActions(p) {
    const box = clear(M.actionsBox);
    if (!hasMedia(p)) return box.appendChild(el('p', { class: 'muted', text: 'This piece has no preview yet, so it cannot be reviewed.' }));
    if (P.pending[p.id]) return box.appendChild(el('p', { class: 'muted', text: 'Saving…' }));
    const st = stateOf(p);
    if (st.reply && st.reply.tipo === 'descartada' && !st.decision) return box.appendChild(el('p', { class: 'muted', text: 'This piece was removed.' }));
    if (M.form === 'adjust') {
      const ta = el('textarea', { rows: 4, maxlength: MAX_NOTE, placeholder: 'What should Claude change? (required)', 'aria-label': 'What to adjust',
        oninput: (e) => { M.draft = e.target.value; } });
      ta.value = M.draft;
      const errEl = el('p', { class: 'form-err', role: 'alert' });
      add(box, ta, errEl, el('div', { class: 'row' }, [
        el('button', { class: 'btn warn', type: 'button', text: 'Send adjustment', onclick: () => {
          const t = M.draft.trim();
          if (!t) { errEl.textContent = 'Please write what to adjust.'; ta.focus(); return; }
          M.form = ''; M.draft = '';
          decideAndNext(p, 'warn', t);
        } }),
        el('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => { M.form = ''; fillActions(p); } }),
      ]));
      setTimeout(() => ta.focus(), 0);
      return;
    }
    if (M.form === 'approve') {
      const ta = el('textarea', { rows: 3, maxlength: 2000, placeholder: 'Extra instruction for Claude (optional)', 'aria-label': 'Extra instruction',
        oninput: (e) => { M.draft = e.target.value; } });
      ta.value = M.draft;
      const errEl = el('p', { class: 'form-err', role: 'alert' });
      add(box, el('p', { class: 'small', text: 'Claude will remake this piece following the reviewer’s comment above.' }), ta, errEl, el('div', { class: 'row' }, [
        el('button', { class: 'btn warn', type: 'button', text: 'Remake now', onclick: (e) => {
          e.target.disabled = true;
          requestJob('remake', M.draft.trim(), p.id).then((res) => {
            if (!res.ok) { e.target.disabled = false; errEl.textContent = jobErr(res.error); return; }
            M.form = ''; M.draft = '';
            renderProject(); refreshModal(); fillActions(p);
          });
        } }),
        el('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => { M.form = ''; fillActions(p); } }),
      ]));
      return;
    }
    if (M.form === 'reject') {
      add(box, el('p', { class: 'confirm', text: 'Reject this piece? Claude will remove it from the review.' }), el('div', { class: 'row' }, [
        el('button', { class: 'btn out', type: 'button', text: 'Yes, reject', onclick: () => { M.form = ''; decideAndNext(p, 'out', ''); } }),
        el('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => { M.form = ''; fillActions(p); } }),
      ]));
      return;
    }
    const cur = st.decision ? st.decision.estado : '';
    box.appendChild(el('div', { class: 'row' }, [
      el('button', { class: 'btn ok' + (cur === 'ok' ? ' current' : ''), type: 'button', text: 'Accept', disabled: cur === 'ok', onclick: () => decideAndNext(p, 'ok', '') }),
      el('button', { class: 'btn warn' + (cur === 'warn' ? ' current' : ''), type: 'button', text: 'Adjust', onclick: () => { M.form = 'adjust'; fillActions(p); } }),
      el('button', { class: 'btn out' + (cur === 'out' ? ' current' : ''), type: 'button', text: 'Reject', disabled: cur === 'out', onclick: () => { M.form = 'reject'; fillActions(p); } }),
    ]));
    if (cur) box.appendChild(el('p', { class: 'muted small', text: 'You can still change your decision until Claude picks it up.' }));
    // Solo el dueño: el Adjust de otro revisor no lanza a Claude hasta que él lo aprueba.
    if (isOwner() && cur === 'warn' && (!st.reply || st.reply.tipo === 'working')) {
      if (remakeOpen(p.id)) box.appendChild(el('p', { class: 'muted small', text: 'Claude is remaking this piece.' }));
      else if (String(st.decision.who_role || '') !== 'owner') {
        box.appendChild(el('button', { class: 'btn small', type: 'button', text: 'Approve & remake', title: 'Let Claude remake this piece with the reviewer’s comment',
          onclick: () => { M.form = 'approve'; M.draft = ''; fillActions(p); } }));
      }
    }
  }

  // ───────── panel «Reviewers» (admin y Claude) ─────────

  const R = { dlg: null, list: null, result: null, formBox: null, rows: [], confirm: '' };

  function siteUrl() {
    let s = typeof CFG.site === 'string' && /^https?:\/\//.test(CFG.site) ? CFG.site : location.origin + location.pathname.replace(/[^/]*$/, '');
    if (s.slice(-1) !== '/') s += '/';
    return s;
  }
  function companyName(id) { const c = companies.find((x) => x.id === id) || knownOf(id); return c ? String(c.nombre || id) : id; }
  // projects llega como texto ('*' o 'acme,beta'); se acepta también un array.
  function scopeText(pr) {
    if (pr === '*') return 'All companies';
    const ids = (Array.isArray(pr) ? pr : String(pr || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
    return ids.length ? ids.map(companyName).join(', ') : 'No companies';
  }

  function openReviewers() {
    if (!R.dlg) {
      R.dlg = makeDialog('reviewers', 'Reviewers');
      R.dlg.addEventListener('close', () => { if (!R.dlg.open) { clear(R.result); R.confirm = ''; } });
      R.list = el('div', { class: 'rv-list' });
      R.result = el('div', { class: 'rv-result', 'aria-live': 'polite' });
      R.dlg.appendChild(el('div', { class: 'dlg-inner narrow' }, [
        el('header', { class: 'dlg-head' }, [el('h2', { text: 'Reviewers' }), el('div', { class: 'spacer' }),
          el('button', { class: 'btn ghost small', type: 'button', text: 'Close', onclick: () => closeDialog(R.dlg) })]),
        el('p', { class: 'muted', text: 'Each reviewer gets a private link. They only see the companies you pick.' }),
        R.list, el('h3', { text: 'Create token' }), R.formBox = el('div'), R.result,
      ]));
    }
    clear(R.formBox).appendChild(createForm());
    openDialog(R.dlg);
    loadReviewers();
  }

  function loadReviewers() {
    clear(R.list).appendChild(el('p', { class: 'muted', text: 'Loading…' }));
    api('reviewers', { op: 'list' }).then((res) => {
      if (!res.ok) { clear(R.list).appendChild(el('p', { class: 'form-err', text: errText(res.error) })); return; }
      R.rows = Array.isArray(res.reviewers) ? res.reviewers.filter(isObj) : [];
      renderReviewers();
    });
  }

  function renderReviewers() {
    const act = R.rows.filter((r) => r.active);
    const off = R.rows.length - act.length;
    clear(R.list);
    if (!act.length) R.list.appendChild(el('p', { class: 'muted', text: 'No active reviewers yet.' }));
    act.forEach((r) => {
      const name = String(r.name || '');
      const ctl = R.confirm === name
        ? el('div', { class: 'row tight' }, [
          el('span', { class: 'confirm', text: 'Revoke ' + name + '? Their link stops working.' }),
          el('button', { class: 'btn out small', type: 'button', text: 'Revoke', onclick: (e) => revoke(name, e.target) }),
          el('button', { class: 'btn ghost small', type: 'button', text: 'Cancel', onclick: () => { R.confirm = ''; renderReviewers(); } })])
        : el('button', { class: 'btn ghost small', type: 'button', text: 'Revoke', onclick: () => { R.confirm = name; renderReviewers(); } });
      R.list.appendChild(el('div', { class: 'rv-row' }, [
        el('div', { class: 'rv-main' }, [
          el('strong', { text: name }), ' ', el('span', { class: 'pill', text: ROLE_LABEL[r.role] || String(r.role || '') }),
          el('p', { class: 'muted small', text: scopeText(r.projects) + ' · token ' + String(r.token || '') + (when(r.created) ? ' · created ' + when(r.created) : '') }),
        ]),
        ctl,
      ]));
    });
    if (off) R.list.appendChild(el('p', { class: 'muted small', text: off + ' revoked ' + (off === 1 ? 'link' : 'links') + ' not shown.' }));
  }

  function revoke(name, btn) {
    btn.disabled = true;
    send('reviewers', { op: 'revoke', name: name }).then((res) => {
      R.confirm = '';
      if (res.ok) toast(name + ' can no longer review.', 'ok'); else toast('Not revoked: ' + errText(res.error), 'error');
      loadReviewers();
    });
  }

  function createForm() {
    const master = me.role === 'claude';
    // Empresas que puede dar quien crea: las del índice dentro de su alcance, más las de su alcance que no estén publicadas.
    const ids = companies.map((c) => c.id);
    if (me.projects !== '*') me.projects.forEach((id) => { if (ids.indexOf(id) < 0) ids.push(id); });
    const nameIn = el('input', { type: 'text', maxlength: 60, required: true, placeholder: 'e.g. Mike', autocomplete: 'off', 'aria-label': 'Reviewer name' });
    const roleSel = master ? el('select', { 'aria-label': 'Role' }, [el('option', { value: 'reviewer', text: 'Reviewer' }), el('option', { value: 'admin', text: 'Admin (can create reviewers)' })]) : null;
    const boxes = ids.map((id) => el('input', { type: 'checkbox', value: id }));
    const allBox = me.projects === '*' ? el('input', { type: 'checkbox', onchange: (e) => boxes.forEach((b) => { b.disabled = e.target.checked; }) }) : null;
    const errEl = el('p', { class: 'form-err', role: 'alert' });
    const submit = el('button', { class: 'btn', type: 'submit', text: 'Create token' });
    const form = el('form', { class: 'rv-form', onsubmit: (e) => {
      e.preventDefault();
      errEl.textContent = '';
      const name = nameIn.value.trim();
      const picked = boxes.filter((b) => b.checked).map((b) => b.value);
      if (!name) { errEl.textContent = 'Type a name.'; nameIn.focus(); return; }
      if (!(allBox && allBox.checked) && !picked.length) { errEl.textContent = errText('bad_projects'); return; }
      submit.disabled = true;
      const body = { op: 'add', name: name, role: roleSel ? roleSel.value : 'reviewer', projects: allBox && allBox.checked ? '*' : picked.join(',') };
      // `req` hace idempotente la creación: si Google pierde la respuesta, el reintento (send) recibe el mismo token.
      body.req = Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, '0')).join('');
      send('reviewers', body).then((res) => {
        submit.disabled = false;
        if (!res.ok || !/^[0-9a-f]{32}$/.test(String(res.token || ''))) { errEl.textContent = errText(res.error || 'bad_response'); return; }
        form.reset();
        boxes.forEach((b) => { b.disabled = false; });
        showLink(String(res.name || name), siteUrl() + '#k=' + res.token);
        loadReviewers();
      });
    } }, [
      el('label', { class: 'field' }, [el('span', { text: 'Name' }), nameIn]),
      roleSel ? el('label', { class: 'field' }, [el('span', { text: 'Role' }), roleSel]) : null,
      el('fieldset', { class: 'field' }, [el('legend', { text: 'Companies' }),
        allBox ? el('label', { class: 'check' }, [allBox, ' All companies (including future ones)']) : null]
        .concat(boxes.map((b) => el('label', { class: 'check' }, [b, ' ' + companyName(b.value)])))),
      errEl, submit,
    ]);
    return form;
  }

  // El enlace completo se ve UNA sola vez (el backend no lo vuelve a dar).
  function showLink(name, link) {
    const input = el('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Review link for ' + name, onfocus: (e) => e.target.select() });
    const done = el('span', { class: 'muted small', 'aria-live': 'polite' });
    clear(R.result).appendChild(el('div', { class: 'linkbox' }, [
      el('p', {}, [el('strong', { text: 'Link for ' + name + '. ' }), 'It is shown only once: copy it now and send it privately.']),
      el('div', { class: 'row tight' }, [input, el('button', { class: 'btn', type: 'button', text: 'Copy link', onclick: () => copyText(input, done) })]),
      done,
      el('button', { class: 'btn ghost small', type: 'button', text: 'Done', onclick: () => clear(R.result) }),
    ]));
    input.focus();
  }

  function copyText(input, done) {
    const ok = () => { done.textContent = 'Copied.'; };
    const fallback = () => {
      input.select();
      let r = false;
      try { r = document.execCommand('copy'); } catch (e) { r = false; }
      done.textContent = r ? 'Copied.' : 'Select the link and copy it by hand.';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(input.value).then(ok, fallback);
    else fallback();
  }

  // ───────── empresas nuevas (dueño: admin/claude con alcance '*') ─────────
  // El dueño pide la empresa; el servicio del Mac crea su carpeta (oculta) en su siguiente pasada. El nombre y
  // la web son datos: el backend y el Mac los validan con las mismas listas blancas que aquí.

  const NOMBRE_RE = /^[A-Za-z0-9 &.,'’-]{1,60}$/;
  const WEB_RE = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/[A-Za-z0-9._~%\/?#=&+-]*)?$/;
  const PROJECT_ERR = {
    bad_name: 'Use 1–60 letters, digits, spaces or & . , \' - (no quotes or other symbols).',
    bad_web: 'Type a full website address, like https://example.com (max 200 characters).',
    name_taken: 'There is already a request for that company.',
    too_many: 'There are already 3 companies waiting to be set up. Try again after the next one is ready.',
    forbidden: 'Only the owner can create companies.',
    bad_action: 'The review server needs to be updated before companies can be created here.',
  };
  const PSTATUS_LABEL = { requested: 'Requested', building: 'Setting up…', ready: 'Ready', failed: 'Failed' };
  const PSTATUS_CLASS = { requested: 'p-review', building: 'p-warn', ready: 'p-ok', failed: 'p-out' };
  const N = { dlg: null, list: null, formBox: null, timer: null, loading: false };

  function projectErr(code) { return PROJECT_ERR[code] || errText(code); }

  function openNewCompany() {
    if (!N.dlg) {
      N.dlg = makeDialog('reviewers newco', 'New company');
      // Sondeo solo mientras el diálogo está abierto.
      N.dlg.addEventListener('close', () => { if (N.timer) { clearInterval(N.timer); N.timer = null; } });
      N.list = el('div', { class: 'rv-list', 'aria-live': 'polite' });
      N.formBox = el('div');
      N.dlg.appendChild(el('div', { class: 'dlg-inner narrow' }, [
        el('header', { class: 'dlg-head' }, [el('h2', { text: 'New company' }), el('div', { class: 'spacer' }),
          el('button', { class: 'btn ghost small', type: 'button', text: 'Close', onclick: () => closeDialog(N.dlg) })]),
        el('p', { class: 'muted', text: 'Claude sets up a private folder for the company on the Mac. It stays hidden from reviewers until you finish its brand setup with Claude.' }),
        N.formBox, el('h3', { text: 'Requests' }), N.list,
      ]));
    }
    clear(N.formBox).appendChild(newCompanyForm());
    openDialog(N.dlg);
    loadProjects();
    if (!N.timer) {
      N.timer = setInterval(() => {
        if (!N.dlg.open && !N.dlg.hasAttribute('open')) { clearInterval(N.timer); N.timer = null; return; }  // respaldo sin evento close
        if (!document.hidden) loadProjects(true);
      }, POLL_MS);
    }
  }

  function newCompanyForm() {
    const nameIn = el('input', { type: 'text', maxlength: 60, required: true, placeholder: 'e.g. Acme Roofing', autocomplete: 'off', 'aria-label': 'Company name' });
    const webIn = el('input', { type: 'text', maxlength: 200, inputmode: 'url', placeholder: 'https://example.com (optional)', autocomplete: 'off', 'aria-label': 'Website' });
    const errEl = el('p', { class: 'form-err', role: 'alert' });
    const okEl = el('p', { class: 'muted small', 'aria-live': 'polite' });
    const submit = el('button', { class: 'btn', type: 'submit', text: 'Create' });
    const form = el('form', { class: 'rv-form', onsubmit: (e) => {
      e.preventDefault();
      errEl.textContent = ''; okEl.textContent = '';
      const nombre = nameIn.value.trim();
      let web = webIn.value.trim();
      if (web && !/^[a-z][a-z0-9+.-]*:/i.test(web)) web = 'https://' + web;  // «acme.com» → https://acme.com
      if (!nombre || !NOMBRE_RE.test(nombre) || !/[A-Za-z0-9]/.test(nombre)) { errEl.textContent = projectErr('bad_name'); nameIn.focus(); return; }
      if (web && (web.length > 200 || !WEB_RE.test(web))) { errEl.textContent = projectErr('bad_web'); webIn.focus(); return; }
      submit.disabled = true;
      const body = { nombre: nombre };
      if (web) body.web = web;
      // Sin reintentos automáticos: repetir tras un fallo tardío chocaría con name_taken.
      api('project_request', body).then((res) => {
        submit.disabled = false;
        if (!res.ok) { errEl.textContent = projectErr(res.error); loadProjects(); return; }
        form.reset();
        okEl.textContent = 'Requested ' + String(res.nombre || nombre) + '. Claude sets it up within a few minutes.';
        loadProjects();
      });
    } }, [
      el('label', { class: 'field' }, [el('span', { text: 'Name' }), nameIn]),
      el('label', { class: 'field' }, [el('span', { text: 'Website (optional)' }), webIn]),
      errEl, okEl, submit,
    ]);
    return form;
  }

  function loadProjects(quiet) {
    if (N.loading) return;
    N.loading = true;
    if (!quiet && !N.list.firstChild) N.list.appendChild(el('p', { class: 'muted', text: 'Loading…' }));
    api('projects').then((res) => {
      N.loading = false;
      if (!res.ok) {
        if (quiet && RETRYABLE[res.error]) return;  // un fallo pasajero del sondeo no borra la lista
        clear(N.list).appendChild(el('p', { class: 'form-err', text: projectErr(res.error) }));
        return;
      }
      renderProjects(Array.isArray(res.projects) ? res.projects.filter(isObj) : []);
    });
  }

  function renderProjects(rows) {
    rows = rows.slice().sort((a, b) => String(b.t || '').localeCompare(String(a.t || ''))).slice(0, 20);
    clear(N.list);
    if (!rows.length) { N.list.appendChild(el('p', { class: 'muted', text: 'No companies requested yet.' })); return; }
    rows.forEach((r) => {
      const st = String(r.status || '');
      const note = String(r.note || '');
      let detail = null;
      if (st === 'ready') {
        detail = el('p', { class: 'small' }, ['Open Claude in ', el('code', { text: note || 'its folder' }),
          ' to finish the brand setup; it stays hidden until then.']);
      } else if (st === 'failed') {
        detail = el('p', { class: 'form-err small', text: note || 'Setup failed.' });
      } else if (st === 'requested') {
        detail = el('p', { class: 'muted small', text: 'Waiting for the Mac (it checks every 2 minutes).' });
      }
      N.list.appendChild(el('div', { class: 'rv-row' }, [
        el('div', { class: 'rv-main' }, [
          el('strong', { text: String(r.nombre || r.id || '') }), ' ',
          el('span', { class: 'pill ' + (PSTATUS_CLASS[st] || ''), text: PSTATUS_LABEL[st] || st }),
          el('p', { class: 'muted small', text: [String(r.id || ''), String(r.web || ''), r.who ? 'by ' + String(r.who) : '', ago(r.t)].filter(Boolean).join(' · ') }),
          detail,
        ]),
      ]));
    });
  }

  boot();
})();
