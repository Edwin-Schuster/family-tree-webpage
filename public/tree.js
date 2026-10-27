'use strict';

(() => {
  const { el, fullName, lifespan, avatar, byBirth, indexPeople, fmtDate, isoParts, yearNum, isLiving, coupleEvents, relationship, MONTHS } = window.FT;
  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const VIEWS = [['whole', 'Whole tree'], ['family', 'Family'], ['ancestors', 'Ancestors'], ['descendants', 'Descendants'], ['everyone', 'Everyone'],
    ['calendar', 'Calendar'], ['relationships', 'How are we related?']];
  const CHART_VIEWS = ['whole', 'family', 'ancestors', 'descendants'];

  const viewport = $('viewport');
  const viewEl = $('view');
  const barEl = $('view-bar');
  const detailsEl = $('details');
  const searchInput = $('search');
  const searchResults = $('search-results');

  let people = [];
  let byId = new Map();
  let children = new Map();
  let view = 'whole';
  let focusId = null;
  let selectedId = null;
  let zoom = 1;
  let depth = 3;
  let descRoot = null;
  const toggled = new Set(); // couples whose default open/closed state the viewer flipped
  let listFilter = '';
  let listSort = ['name', 1];
  let drawLines = null;
  let relA = null, relB = null;

  // ---------- small helpers ----------
  const get = (id) => byId.get(id);
  const store = {
    read(key) { try { return localStorage.getItem(key); } catch { return null; } },
    write(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
  };

  function partnersOf(p) {
    const ids = [...p.spouseIds];
    for (const child of children.get(p.id)) {
      for (const pid of child.parentIds) if (pid !== p.id && !ids.includes(pid)) ids.push(pid);
    }
    return ids.map(get).filter(Boolean);
  }
  function siblingsOf(p) {
    return people.filter((o) => o.id !== p.id && o.parentIds.some((id) => p.parentIds.includes(id))).sort(byBirth);
  }
  /** [father, mother], each possibly null, so charts keep the father's side on one side. */
  function parentSlots(p) {
    const ps = p.parentIds.map(get).filter(Boolean);
    let father = ps.find((x) => x.gender === 'male') || null;
    let mother = ps.find((x) => x.gender === 'female' && x !== father) || null;
    for (const x of ps) {
      if (x === father || x === mother) continue;
      if (!father) father = x; else if (!mother) mother = x;
    }
    return [father, mother];
  }
  const descCount = new Map();
  function countDescendants(id) {
    if (descCount.has(id)) return descCount.get(id);
    const seen = new Set();
    const stack = [id];
    while (stack.length) {
      for (const k of children.get(stack.pop())) if (!seen.has(k.id)) { seen.add(k.id); stack.push(k.id); }
    }
    descCount.set(id, seen.size);
    return seen.size;
  }
  /** Family lines worth starting a descendants chart from: the founders with the most descendants. */
  function mainRoots() {
    const covered = new Set();
    const roots = people.filter((p) => !p.parentIds.length && countDescendants(p.id) >= 3)
      .sort((a, b) => countDescendants(b.id) - countDescendants(a.id));
    const out = [];
    for (const r of roots) {
      if (covered.has(r.id)) continue;
      out.push(r);
      for (const s of partnersOf(r)) covered.add(s.id);
      if (out.length >= 8) break;
    }
    return out;
  }
  function oldestAncestor(p) {
    let cur = p;
    const seen = new Set();
    while (cur.parentIds.length && !seen.has(cur.id)) {
      seen.add(cur.id);
      const [father, mother] = parentSlots(cur);
      cur = father || mother;
    }
    return cur;
  }
  function relWord(kind, p) {
    const words = { parent: ['Father', 'Mother', 'Parent'], spouse: ['Husband', 'Wife', 'Partner'], sibling: ['Brother', 'Sister', 'Sibling'],
      child: ['Son', 'Daughter', 'Child'], grandparent: ['Grandfather', 'Grandmother', 'Grandparent'] }[kind];
    return p.gender === 'male' ? words[0] : p.gender === 'female' ? words[1] : words[2];
  }

  // ---------- navigation ----------
  function go(id, nextView = view) {
    if (!byId.has(id)) return;
    focusId = id;
    selectedId = id;
    view = CHART_VIEWS.includes(nextView) ? nextView : 'family';
    if (view === 'descendants') descRoot = id;
    render(true);
  }
  function select(id) {
    selectedId = id;
    for (const b of viewEl.querySelectorAll('.pbox')) b.classList.toggle('sel', b.dataset.id === id);
    renderDetails();
  }
  function saveHash() {
    try { history.replaceState(null, '', `#${view}${focusId ? '/' + encodeURIComponent(focusId) : ''}`); } catch { /* ignore */ }
    if (focusId) store.write('ft-last', focusId);
    store.write('ft-view', view);
  }
  function readHash() {
    const [v, id] = location.hash.slice(1).split('/');
    if (VIEWS.some(([k]) => k === v)) view = v;
    const pid = id && decodeURIComponent(id);
    if (pid && byId.has(pid)) focusId = pid;
  }

  // ---------- person boxes ----------
  function pbox(p, opts = {}) {
    const cls = ['pbox', p.gender || 'other', opts.row ? 'row' : '', opts.focus ? 'focus' : '', p.id === selectedId ? 'sel' : '', opts.ref ? 'ref' : ''];
    const text = [el('div', { className: 'name' }, fullName(p)), el('div', { className: 'dates' }, lifespan(p) || ' ')];
    const act = () => (opts.onpick ? opts.onpick(p.id) : go(p.id));
    return el('div', {
      className: cls.filter(Boolean).join(' '), tabIndex: 0, role: 'button', dataset: { id: p.id },
      'aria-label': `${opts.tag ? opts.tag + ': ' : ''}${fullName(p)} ${lifespan(p)}`.trim(),
      onclick: act,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } },
    }, opts.tag && !opts.row ? el('div', { className: 'tag' }, opts.tag) : null, avatar(p),
    opts.row ? el('div', { className: 'tx' }, text) : text,
    opts.ref ? el('div', { className: 'dates' }, 'shown above') : null);
  }

  // ---------- connector lines (family + ancestor charts) ----------
  function offsetIn(node, root) {
    let x = 0, y = 0, n = node;
    while (n && n !== root) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    return { x, y, w: node.offsetWidth, h: node.offsetHeight };
  }
  function connect(chart, groups, orient) {
    let svg = chart.querySelector(':scope > svg.lines');
    if (!svg) { svg = document.createElementNS(SVG_NS, 'svg'); svg.setAttribute('class', 'lines'); chart.prepend(svg); }
    svg.setAttribute('width', chart.scrollWidth);
    svg.setAttribute('height', chart.scrollHeight);
    const paths = [];
    for (const g of groups) {
      const from = g.from.filter(Boolean).map((n) => offsetIn(n, chart));
      const to = g.to.filter(Boolean).map((n) => offsetIn(n, chart));
      if (!from.length || !to.length && orient === 'h') continue;
      if (orient === 'v') {
        let ax, ay;
        if (from.length === 2) {
          const [l, r] = from.sort((a, b) => a.x - b.x);
          ay = Math.min(l.y + l.h / 2, r.y + r.h / 2);
          paths.push([`M${l.x + l.w} ${ay}H${r.x}`, 'wed']);
          ax = (l.x + l.w + r.x) / 2;
        } else {
          ax = from[0].x + from[0].w / 2; ay = from[0].y + from[0].h;
        }
        if (!to.length) continue;
        const bus = Math.min(...to.map((t) => t.y)) - 18;
        const xs = to.map((t) => t.x + t.w / 2);
        let d = `M${ax} ${ay}V${bus}M${Math.min(ax, ...xs)} ${bus}H${Math.max(ax, ...xs)}`;
        for (const t of to) d += `M${t.x + t.w / 2} ${bus}V${t.y}`;
        paths.push([d, '']);
      } else {
        const c = from[0];
        const ax = c.x + c.w, ay = c.y + c.h / 2, bus = ax + 25;
        const ys = to.map((t) => t.y + t.h / 2);
        let d = `M${ax} ${ay}H${bus}M${bus} ${Math.min(ay, ...ys)}V${Math.max(ay, ...ys)}`;
        for (const t of to) d += `M${bus} ${t.y + t.h / 2}H${t.x}`;
        paths.push([d, '']);
      }
    }
    svg.replaceChildren(...paths.map(([d, c]) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      if (c) path.setAttribute('class', c);
      return path;
    }));
  }

  // ---------- views ----------
  function zoomControls() {
    return el('span', { className: 'zoom' },
      el('button', { type: 'button', 'aria-label': 'Zoom out', onclick: () => setZoom(zoom - 0.1) }, '−'),
      el('button', { type: 'button', id: 'zoom-value', 'aria-label': 'Reset zoom', onclick: () => setZoom(1) }, `${Math.round(zoom * 100)}%`),
      el('button', { type: 'button', 'aria-label': 'Zoom in', onclick: () => setZoom(zoom + 0.1) }, '+'),
      el('button', { type: 'button', onclick: fitToScreen }, 'Fit'));
  }
  function setZoom(z) {
    zoom = Math.min(1.6, Math.max(0.08, Math.round(z * 100) / 100));
    const chart = viewEl.querySelector('.chart');
    if (chart) chart.style.zoom = zoom;
    const label = $('zoom-value');
    if (label) label.textContent = `${Math.round(zoom * 100)}%`;
  }
  function fitToScreen() {
    const chart = viewEl.querySelector('.chart');
    if (!chart) return;
    const w = chart.scrollWidth, h = chart.scrollHeight;
    const availW = viewport.clientWidth - 40, availH = viewport.clientHeight - 60;
    setZoom(Math.min(1, availW / w, availH / h));
    viewport.scrollTo({ left: 0, top: 0 });
  }

  function familyView() {
    const f = get(focusId);
    const [father, mother] = parentSlots(f);
    const groups = [];
    const gpBoxes = (par) => {
      if (!par) return [];
      return parentSlots(par).filter(Boolean).map((g) => pbox(g, { tag: relWord('grandparent', g) }));
    };
    const fBox = father ? pbox(father, { tag: relWord('parent', father) }) : null;
    const mBox = mother ? pbox(mother, { tag: relWord('parent', mother) }) : null;
    const gpF = gpBoxes(father), gpM = gpBoxes(mother);
    if (gpF.length) groups.push({ from: gpF, to: [fBox] });
    if (gpM.length) groups.push({ from: gpM, to: [mBox] });

    const focusBox = pbox(f, { focus: true });
    const partners = partnersOf(f);
    const partnerBoxes = partners.map((s) => {
      const wed = coupleEvents(f, s).find((e) => e.type === 'Marriage');
      const y = wed && yearNum(wed.date);
      return pbox(s, { tag: (f.spouseIds.includes(s.id) ? relWord('spouse', s) : 'Partner') + (y ? ` · m. ${y}` : '') });
    });
    const gen0 = [];
    const sibBoxes = [];
    for (const p of [...siblingsOf(f), f].sort(byBirth)) {
      if (p === f) gen0.push(focusBox, ...partnerBoxes);
      else { const b = pbox(p, { tag: relWord('sibling', p) }); sibBoxes.push(b); gen0.push(b); }
    }
    if (fBox || mBox) groups.push({ from: [fBox, mBox].filter(Boolean), to: [focusBox, ...sibBoxes] });

    const kids = children.get(f.id);
    const kidBoxes = new Map(kids.map((k) => [k.id, pbox(k, { tag: relWord('child', k) })]));
    partners.forEach((s, i) => {
      const theirs = kids.filter((k) => k.parentIds.includes(s.id));
      groups.push({ from: [focusBox, partnerBoxes[i]], to: theirs.map((k) => kidBoxes.get(k.id)) });
    });
    const solo = kids.filter((k) => !k.parentIds.some((id) => partners.some((s) => s.id === id)));
    if (solo.length) groups.push({ from: [focusBox], to: solo.map((k) => kidBoxes.get(k.id)) });

    const rows = [];
    if (gpF.length || gpM.length) rows.push(el('div', { className: 'halves gp' }, el('div', {}, gpF), el('div', {}, gpM)));
    if (fBox || mBox) rows.push(el('div', { className: 'halves' }, el('div', {}, fBox || el('div', { className: 'pbox ghost' })), el('div', {}, mBox || el('div', { className: 'pbox ghost' }))));
    rows.push(el('div', { className: 'row gen0' }, gen0));
    if (kids.length) rows.push(el('div', { className: 'row' }, [...kidBoxes.values()]));
    const chart = el('div', { className: 'chart' }, el('div', { className: 'fam' }, rows));
    drawLines = () => connect(chart, groups, 'v');
    const bits = [];
    if (!f.parentIds.length) bits.push('no parents recorded');
    bits.push(`${kids.length} ${kids.length === 1 ? 'child' : 'children'}`);
    return { title: `${fullName(f)}’s family`, hint: `Click anyone to move them to the centre · ${bits.join(' · ')}`, chart };
  }

  function ancestorsView() {
    const f = get(focusId);
    const GENS = 4, SLOT = 66;
    const cols = [], groups = [];
    let prev = [];
    for (let g = 0; g < GENS; g++) {
      const col = el('div', { className: 'col' });
      col.style.height = `${SLOT * 2 ** (GENS - 1)}px`;
      const cur = [];
      if (g === 0) {
        const b = pbox(f, { row: true, focus: true });
        col.append(b); cur.push({ p: f, box: b });
      } else {
        for (const item of prev) {
          const pair = item.p ? parentSlots(item.p) : [null, null];
          const boxes = pair.map((q) => {
            const b = q ? pbox(q, { row: true }) : el('div', { className: 'slot-empty' });
            col.append(b);
            return { p: q, box: b };
          });
          const real = boxes.filter((x) => x.p).map((x) => x.box);
          if (item.p && real.length) groups.push({ from: [item.box], to: real });
          cur.push(...boxes);
        }
      }
      cols.push(col);
      prev = cur;
    }
    const chart = el('div', { className: 'chart' }, el('div', { className: 'ped' }, cols));
    drawLines = () => connect(chart, groups, 'h');
    const top = oldestAncestor(f);
    return { title: `Ancestors of ${fullName(f)}`, hint: `Four generations · earliest known: ${fullName(top)}${top.birthDate ? ` (${lifespan(top)})` : ''}`, chart };
  }

  /** Draws a person, their partners and their descendants. `placed` is shared across calls, so anyone
   *  already drawn appears again only as a dashed "shown above" box. */
  function makeBrancher(placed, isOpen, pick, isRoot) {
    const branch = (p, gen) => {
      placed.add(p.id);
      const partners = partnersOf(p);
      const unit = el('div', { className: 'couple' }, pbox(p, { onpick: pick, focus: isRoot(p.id) }));
      for (const s of partners) {
        unit.append(el('span', { className: 'wed', 'aria-hidden': 'true' }), pbox(s, { onpick: pick }));
        placed.add(s.id);
      }
      const li = el('li', {}, unit);
      const mine = children.get(p.id);
      if (!mine.length) return li;
      const open = isOpen(p.id, gen);
      const flip = () => { if (toggled.has(p.id)) toggled.delete(p.id); else toggled.add(p.id); renderView(false); };
      const total = countDescendants(p.id);
      unit.append(el('button', { type: 'button', className: 'tog' + (open ? '' : ' closed'), 'aria-expanded': String(open), onclick: flip },
        open ? 'Hide' : `+ ${total} descendant${total === 1 ? '' : 's'}`));
      if (open) {
        const ordered = [];
        for (const s of partners) ordered.push(...mine.filter((k) => k.parentIds.includes(s.id) && !ordered.includes(k)));
        ordered.push(...mine.filter((k) => !ordered.includes(k)));
        li.append(el('ul', {}, ordered.map((k) => placed.has(k.id)
          ? el('li', {}, el('div', { className: 'couple' }, pbox(k, { ref: true, onpick: pick })))
          : branch(k, gen + 1))));
      }
      return li;
    };
    return branch;
  }

  function descendantsView() {
    const root = get(descRoot) || get(focusId);
    const branch = makeBrancher(new Set(), (id, gen) => (gen < depth) !== toggled.has(id), select, (id) => id === root.id);
    const chart = el('div', { className: 'chart' }, el('div', { className: 'dtree' }, el('ul', {}, branch(root, 0))));
    drawLines = null;
    return { title: `Descendants of ${fullName(root)}`, hint: `${countDescendants(root.id)} descendants · click a person for details`, chart };
  }

  /** Everyone at once, like the original page: each family line from its earliest ancestor, fully open. */
  function wholeView() {
    const placed = new Set();
    const pickHere = (id) => { focusId = id; select(id); saveHash(); };
    const branch = makeBrancher(placed, (id) => !toggled.has(id), pickHere, () => false);
    const hasParents = (p) => p.parentIds.some((id) => byId.has(id));
    const roots = people.filter((p) => !hasParents(p) && !partnersOf(p).some(hasParents))
      .sort((a, b) => countDescendants(b.id) - countDescendants(a.id) || byBirth(a, b));
    const main = [];
    const inLaws = [];
    const later = [];
    for (const r of roots) {
      if (placed.has(r.id)) continue;
      // Parents of someone who married in: their child is already drawn in a bigger family line, so these small
      // families go in a grid below instead of stretching the main chart sideways.
      if (children.get(r.id).length && children.get(r.id).every((k) => placed.has(k.id))) { later.push(r); continue; }
      main.push(el('ul', {}, branch(r, 0)));
    }
    for (const r of [...later, ...people.filter((x) => !hasParents(x))].sort(byBirth)) {
      if (placed.has(r.id)) continue;
      inLaws.push(el('div', { className: 'inlaw' }, el('div', { className: 'dtree' }, el('ul', {}, branch(r, 0)))));
    }
    const chart = el('div', { className: 'chart whole' },
      el('div', { className: 'dtree main-lines' }, main),
      inLaws.length ? el('section', { className: 'inlaws' },
        el('h3', {}, `Parents of people who married into the family (${inLaws.length})`),
        el('div', { className: 'inlaw-grid' }, inLaws)) : null);
    drawLines = null;
    return { title: 'Whole tree', hint: `Everyone, from each family's earliest ancestor · ${people.length} people · use Fit or search to find your way`, chart };
  }

  function personSelect(id, value, onchange) {
    return el('select', { id, onchange },
      [...people].sort((a, b) => fullName(a).localeCompare(fullName(b)))
        .map((p) => el('option', { value: p.id, selected: p.id === value }, `${fullName(p)}${lifespan(p) ? ` (${lifespan(p)})` : ''}`)));
  }

  function relationshipsView() {
    if (!byId.has(relA)) relA = byId.has(store.read('ft-start')) ? store.read('ft-start') : focusId;
    if (!byId.has(relB) || relB === relA) relB = selectedId && selectedId !== relA ? selectedId : (people.find((p) => p.id !== relA) || {}).id;
    const A = get(relA), B = get(relB);
    const r = relationship(A, B, { byId, children });
    const commons = (r.commons || []).map(get).filter(Boolean);
    const sentence = r.none ? [el('strong', {}, fullName(A)), ` is not connected to ${fullName(B)} in this tree.`]
      : r.far ? [el('strong', {}, fullName(A)), ` is related to ${fullName(B)} by marriage.`]
        : [el('strong', {}, fullName(A)), ` is ${fullName(B)}’s `, el('strong', {}, r.word), '.'];
    const card = el('div', { className: 'rel-card' },
      el('div', { className: 'rel-pick' },
        el('label', { htmlFor: 'rel-a' }, 'This person'), personSelect('rel-a', relA, (e) => { relA = e.target.value; renderView(false); })),
      el('button', { type: 'button', className: 'swap', 'aria-label': 'Swap the two people', onclick: () => { [relA, relB] = [relB, relA]; renderView(false); } }, '⇅ Swap'),
      el('div', { className: 'rel-pick' },
        el('label', { htmlFor: 'rel-b' }, 'is related to'), personSelect('rel-b', relB, (e) => { relB = e.target.value; renderView(false); })),
      el('p', { className: 'rel-answer', 'aria-live': 'polite' }, sentence),
      commons.length && r.da > 0 && r.db > 0 ? el('p', { className: 'muted' }, `Common ancestor${commons.length > 1 ? 's' : ''}: ${commons.map(fullName).join(' and ')}`) : null,
      el('div', { className: 'goto' },
        el('button', { type: 'button', onclick: () => go(A.id, 'family') }, `${(A.firstName || fullName(A)).replace(/\s*"[^"]*"/, '')}’s family`),
        el('button', { type: 'button', onclick: () => go(B.id, 'family') }, `${(B.firstName || fullName(B)).replace(/\s*"[^"]*"/, '')}’s family`)));
    drawLines = null;
    return { title: 'How are we related?', hint: 'Pick any two people. Click “Open here next time” on someone to make them the starting choice.', chart: card };
  }

  function calendarView() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const nextDate = (m, d) => {
      let t = new Date(today.getFullYear(), m - 1, d);
      if (t < today) t = new Date(today.getFullYear() + 1, m - 1, d);
      return t;
    };
    const items = [];
    const weddings = new Set();
    for (const p of people) {
      const b = isoParts(p.birthDate);
      if (b && isLiving(p)) { const t = nextDate(b.m, b.d); items.push({ t, p, kind: 'Birthday', cls: 'b', what: `Turns ${t.getFullYear() - b.y}` }); }
      const d = isoParts(p.deathDate);
      if (d) { const t = nextDate(d.m, d.d); items.push({ t, p, kind: 'Remembrance', cls: 'r', what: `${t.getFullYear() - d.y} years since ${p.firstName || fullName(p)} died` }); }
      for (const e of p.events || []) {
        const m = e.type === 'Marriage' && isoParts(e.date);
        if (!m) continue;
        const s = get(e.spouseId);
        const key = `${[p.id, e.spouseId].sort().join('|')}|${e.date}`;
        if (weddings.has(key)) continue; // a wedding recorded on both partners counts once
        weddings.add(key);
        const t = nextDate(m.m, m.d);
        items.push({ t, p, kind: 'Anniversary', cls: 'a', what: `${t.getFullYear() - m.y} years since marrying${s ? ' ' + fullName(s) : ''}` });
      }
    }
    items.sort((a, b) => a.t - b.t);
    const months = new Map();
    for (const it of items) {
      const k = `${MONTHS[it.t.getMonth()]} ${it.t.getFullYear()}`;
      if (!months.has(k)) months.set(k, []);
      months.get(k).push(it);
    }
    drawLines = null;
    const body = items.length
      ? el('div', { className: 'months' }, [...months].map(([k, list]) => el('section', { className: 'month' }, el('h3', {}, k),
        list.map((it) => el('button', { type: 'button', className: 'cal-item', onclick: () => go(it.p.id, 'family') },
          el('span', { className: 'cal-day' }, it.t.getDate()),
          el('span', {}, el('span', { className: `cal-kind ${it.cls}` }, it.kind), el('b', {}, fullName(it.p)), el('span', { className: 'cal-what' }, it.what)))))))
      : el('div', { className: 'empty-state' }, 'Birthdays and anniversaries appear here once people have full dates, like 1984-06-27.');
    const counts = [['Birthday', 'birthdays'], ['Anniversary', 'anniversaries'], ['Remembrance', 'remembrance days']]
      .map(([k, plural]) => `${items.filter((i) => i.kind === k).length} ${plural}`);
    return { title: 'Family calendar', hint: `The next twelve months · ${counts.join(' · ')}`, chart: body };
  }

  function everyoneView() {
    const q = listFilter.trim().toLowerCase();
    const [key, dir] = listSort;
    const val = (p) => key === 'name' ? `${p.lastName} ${p.firstName}`.toLowerCase()
      : key === 'born' ? (p.birthDate || '~') : key === 'died' ? (p.deathDate || '~') : (p.birthPlace || '~').toLowerCase();
    const rows = people.filter((p) => !q || `${fullName(p)} ${p.maidenName} ${p.birthPlace} ${p.deathPlace}`.toLowerCase().includes(q))
      .sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * dir);
    const LIMIT = 300;
    const head = (k, label) => el('th', { 'aria-sort': key === k ? (dir > 0 ? 'ascending' : 'descending') : 'none' },
      el('button', { type: 'button', onclick: () => { listSort = [k, key === k ? -dir : 1]; renderView(false); } }, label, key === k ? (dir > 0 ? ' ▲' : ' ▼') : ''));
    const table = el('div', { className: 'tbl-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, head('name', 'Name'), head('born', 'Born'), head('place', 'Birthplace'), head('died', 'Died'))),
      el('tbody', {}, rows.slice(0, LIMIT).map((p) => el('tr', { tabIndex: 0, onclick: () => go(p.id, 'family'), onkeydown: (e) => { if (e.key === 'Enter') go(p.id, 'family'); } },
        el('td', {}, el('div', { className: 'who' }, avatar(p), fullName(p), p.maidenName ? el('span', { className: 'muted' }, ` (née ${p.maidenName})`) : null)),
        el('td', {}, fmtDate(p.birthDate)), el('td', {}, p.birthPlace), el('td', {}, fmtDate(p.deathDate)))))));
    drawLines = null;
    return { title: 'Everyone', hint: `${rows.length} of ${people.length} people · click a row to open their family`,
      chart: el('div', {}, table, rows.length > LIMIT ? el('p', { className: 'tbl-more' }, `Showing the first ${LIMIT}. Filter by name or place to narrow the list.`) : null) };
  }

  // ---------- rendering ----------
  function renderBar(spec) {
    const controls = [];
    if (view === 'descendants') {
      const root = get(descRoot) || get(focusId);
      const choices = [root, ...mainRoots()].filter((p, i, arr) => p && arr.findIndex((x) => x.id === p.id) === i);
      controls.push(
        el('select', { id: 'desc-root', 'aria-label': 'Start from', onchange: (e) => { descRoot = e.target.value; toggled.clear(); renderView(true); } },
          choices.map((p) => el('option', { value: p.id, selected: p.id === root.id }, `${fullName(p)} (${countDescendants(p.id)})`))),
        el('select', { id: 'desc-depth', 'aria-label': 'Generations shown', onchange: (e) => { depth = Number(e.target.value); toggled.clear(); renderView(false); } },
          [[2, '2 generations'], [3, '3 generations'], [4, '4 generations'], [6, '6 generations'], [99, 'All generations']]
            .map(([v, t]) => el('option', { value: v, selected: depth === v }, t))),
        el('button', { type: 'button', onclick: () => { const top = oldestAncestor(get(focusId)); descRoot = top.id; toggled.clear(); renderView(true); } }, 'From earliest ancestor'));
    }
    if (view === 'everyone') {
      controls.push(el('input', { id: 'list-filter', type: 'search', placeholder: 'Filter by name or place', value: listFilter,
        oninput: (e) => { listFilter = e.target.value; const pos = e.target.selectionStart; renderView(false); const n = $('list-filter'); n.focus(); n.setSelectionRange(pos, pos); } }));
    }
    if (CHART_VIEWS.includes(view)) controls.push(zoomControls());
    barEl.replaceChildren(el('div', {}, el('h2', {}, spec.title), el('div', { className: 'hint' }, spec.hint)), el('span', { className: 'spacer' }), ...controls);
  }

  function renderView(recentre) {
    if (!people.length) {
      barEl.replaceChildren();
      viewEl.replaceChildren(el('div', { className: 'empty-state' },
        el('p', {}, 'No one has been added to the family tree yet.'), el('a', { className: 'button', href: '/admin' }, 'Open the editor')));
      return;
    }
    if (!byId.has(focusId)) focusId = defaultFocus();
    if (view === 'descendants' && !byId.has(descRoot)) descRoot = focusId;
    const keepX = viewport.scrollLeft, keepY = viewport.scrollTop;
    const spec = { whole: wholeView, family: familyView, ancestors: ancestorsView, descendants: descendantsView, everyone: everyoneView,
      calendar: calendarView, relationships: relationshipsView }[view]();
    renderBar(spec);
    viewEl.replaceChildren(spec.chart);
    viewport.classList.toggle('pannable', CHART_VIEWS.includes(view));
    setZoom(zoom);
    if (drawLines) drawLines();
    if (recentre) centreOn(view === 'descendants' ? descRoot : focusId);
    else { viewport.scrollLeft = keepX; viewport.scrollTop = keepY; }
    saveHash();
  }

  function centreOn(id) {
    const box = viewEl.querySelector(`.pbox[data-id="${CSS.escape(id)}"]:not(.ref)`);
    if (!box) { viewport.scrollTo({ left: 0, top: 0 }); return; }
    const a = box.getBoundingClientRect(), b = viewport.getBoundingClientRect();
    viewport.scrollLeft += a.left + a.width / 2 - (b.left + b.width / 2);
    // Start at the top (grandparents visible) unless that would leave the centre person off-screen.
    const below = a.bottom - b.top + viewport.scrollTop;
    viewport.scrollTop = view !== 'descendants' && below > viewport.clientHeight ? below - viewport.clientHeight * 0.6 : 0;
  }

  /** The person's own events plus key moments in close family's lives, oldest first. */
  function lifeEvents(p) {
    const born = yearNum(p.birthDate), died = yearNum(p.deathDate);
    const out = [];
    const add = (date, what, where, own, note = '') => {
      const y = yearNum(date);
      if (!own && y && ((born && y < born) || (died && y > died))) return;
      out.push({ date, what, where, own, note, age: y && born && y >= born ? y - born : null });
    };
    if (p.birthDate || p.birthPlace) add(p.birthDate, 'Born', p.birthPlace, true);
    const spouseEvents = p.spouseIds.map(get).filter(Boolean).flatMap((s) => coupleEvents(p, s).map((e) => ({ ...e, with: s })));
    for (const e of p.events || []) {
      if ((e.type === 'Marriage' || e.type === 'Divorce') && e.spouseId) continue;
      const what = e.type === 'Occupation' ? (e.note ? `Worked as ${e.note.replace(/^an? /i, '')}` : 'Occupation')
        : e.type === 'Education' && e.note ? `Studied at ${e.note}` : e.type;
      add(e.date, what, e.place, true, e.type === 'Occupation' || e.type === 'Education' ? '' : e.note);
    }
    for (const e of spouseEvents) add(e.date, `${e.type === 'Marriage' ? 'Married' : 'Divorced'} ${fullName(e.with)}`, e.place, true, e.note);
    for (const k of children.get(p.id)) if (k.birthDate) add(k.birthDate, `${relWord('child', k)} ${k.firstName || fullName(k)} born`, k.birthPlace, false);
    for (const par of p.parentIds.map(get).filter(Boolean)) if (par.deathDate) add(par.deathDate, `${relWord('parent', par)} ${par.firstName || fullName(par)} died`, par.deathPlace, false);
    for (const s of p.spouseIds.map(get).filter(Boolean)) if (s.deathDate) add(s.deathDate, `${relWord('spouse', s)} ${s.firstName || fullName(s)} died`, s.deathPlace, false);
    if (p.deathDate || p.deathPlace) add(p.deathDate, 'Died', p.deathPlace, true);
    const key = (e) => (e.date || '9999').replace(/^(c\.|bef\.|aft\.) /, '');
    return out.sort((a, b) => key(a).localeCompare(key(b)));
  }

  function lightbox(p, photos, start) {
    let i = start;
    const dlg = el('dialog', { className: 'lightbox' });
    const show = () => {
      dlg.replaceChildren(
        el('img', { src: photos[i], alt: `Photo ${i + 1} of ${fullName(p)}` }),
        el('div', { className: 'lb-bar' },
          photos.length > 1 ? el('button', { type: 'button', onclick: () => { i = (i - 1 + photos.length) % photos.length; show(); } }, '← Previous') : null,
          el('span', {}, `${fullName(p)} · ${i + 1} of ${photos.length}`),
          photos.length > 1 ? el('button', { type: 'button', onclick: () => { i = (i + 1) % photos.length; show(); } }, 'Next →') : null,
          el('button', { type: 'button', onclick: () => dlg.close() }, 'Close')));
    };
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    show();
    document.body.append(dlg);
    dlg.showModal();
  }

  function relativeList(title, list) {
    if (!list.length) return null;
    return [el('h3', {}, title), el('ul', { className: 'relative-list' },
      list.map((p) => el('li', {}, el('button', { type: 'button', onclick: () => go(p.id, view === 'everyone' ? 'family' : view) }, fullName(p)))))];
  }

  function renderDetails() {
    const p = get(selectedId);
    if (!p) { detailsEl.hidden = true; return; }
    const facts = [
      ['Born', [fmtDate(p.birthDate), p.birthPlace].filter(Boolean).join(', ')],
      ['Died', [fmtDate(p.deathDate), p.deathPlace].filter(Boolean).join(', ')],
      ['Née', p.maidenName],
    ].filter(([, v]) => v);
    const isStart = store.read('ft-start') === p.id;
    const homeId = store.read('ft-start');
    const other = get(homeId && homeId !== p.id ? homeId : focusId !== p.id ? focusId : null);
    const rel = other ? relationship(p, other, { byId, children }) : null;
    const photos = [...new Set([p.photoUrl, ...(p.photos || [])].filter(Boolean))];
    const timeline = lifeEvents(p);
    const content = [
      el('button', { className: 'close icon', type: 'button', 'aria-label': 'Close details', onclick: () => { selectedId = null; select(null); } }, '×'),
      avatar(p),
      el('h2', {}, fullName(p)),
      el('p', { className: 'subtitle' }, lifespan(p)),
      el('div', { className: 'goto' },
        el('button', { type: 'button', onclick: () => go(p.id, 'family') }, 'Family'),
        el('button', { type: 'button', onclick: () => go(p.id, 'ancestors') }, 'Ancestors'),
        children.get(p.id).length ? el('button', { type: 'button', onclick: () => go(p.id, 'descendants') }, `Descendants (${countDescendants(p.id)})`) : null,
        el('button', { type: 'button', onclick: () => { store.write('ft-start', p.id); renderDetails(); }, disabled: isStart }, isStart ? 'Opens here' : 'Open here next time'),
        el('a', { className: 'button edit-person', href: `/admin#edit/${encodeURIComponent(p.id)}` }, 'Edit person')),
      rel && !rel.none ? el('p', { className: 'rel-line' }, rel.far ? `Related to ${fullName(other)} by marriage.`
        : `${p.firstName || fullName(p)} is ${fullName(other)}’s ${rel.word}.`) : null,
      facts.length ? el('dl', {}, facts.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])) : null,
      photos.length ? [el('h3', {}, `Photos (${photos.length})`), el('div', { className: 'gallery' },
        photos.map((src, i) => el('button', { type: 'button', 'aria-label': `Photo ${i + 1} of ${fullName(p)}`, onclick: () => lightbox(p, photos, i) },
          el('img', { src, alt: '', loading: 'lazy' }))))] : null,
      timeline.length ? [el('h3', {}, 'Life events'), el('ol', { className: 'timeline' }, timeline.map((e) => el('li', { className: e.own ? 'own' : '' },
        el('div', { className: 'when' }, fmtDate(e.date) || 'Date unknown', e.age != null ? ` · age ${e.age}` : ''),
        el('div', { className: 'what' }, e.what), e.where ? el('div', { className: 'where' }, e.where) : null,
        e.note ? el('div', { className: 'where' }, e.note) : null)))] : null,
      relativeList('Parents', p.parentIds.map(get).filter(Boolean)),
      relativeList('Spouses & partners', partnersOf(p)),
      relativeList('Siblings', siblingsOf(p)),
      relativeList('Children', children.get(p.id)),
      p.bio ? [el('h3', {}, 'Story & notes'), el('p', { className: 'bio' }, p.bio)] : null,
    ];
    detailsEl.replaceChildren(...content.flat().filter(Boolean));
    detailsEl.hidden = false;
    detailsEl.scrollTop = 0;
  }

  function renderTabs() {
    $('tabs').replaceChildren(...VIEWS.map(([k, label]) => el('button', {
      type: 'button', role: 'tab', 'aria-selected': String(view === k),
      onclick: () => { view = k; toggled.clear(); if (k === 'descendants') descRoot = focusId; render(true); },
    }, label)));
  }

  function render(recentre) {
    renderTabs();
    renderView(recentre);
    renderDetails();
  }

  function defaultFocus() {
    for (const id of [store.read('ft-start'), store.read('ft-last')]) if (id && byId.has(id)) return id;
    // Otherwise start with whoever has the most close family on screen.
    const score = (p) => p.parentIds.length * 2 + partnersOf(p).length + children.get(p.id).length + Math.min(siblingsOf(p).length, 4);
    return [...people].sort((a, b) => score(b) - score(a))[0].id;
  }

  // ---------- search ----------
  let hits = [], hitIndex = 0;
  function renderSearch() {
    const q = searchInput.value.trim().toLowerCase();
    hits = q ? people.filter((p) => `${fullName(p)} ${p.maidenName}`.toLowerCase().includes(q)).sort(byBirth).slice(0, 12) : [];
    hitIndex = Math.min(hitIndex, Math.max(0, hits.length - 1));
    searchResults.hidden = !q;
    searchResults.replaceChildren(...(hits.length
      ? hits.map((p, i) => el('li', {}, el('button', { type: 'button', className: i === hitIndex ? 'on' : '', onmousedown: (e) => { e.preventDefault(); pickHit(p); } },
        el('span', {}, fullName(p), p.maidenName ? ` (née ${p.maidenName})` : ''), el('span', { className: 'yrs' }, lifespan(p)))))
      : [el('li', { className: 'none' }, 'No one by that name')]));
  }
  function pickHit(p) {
    searchInput.value = '';
    searchResults.hidden = true;
    searchInput.blur();
    go(p.id, view === 'everyone' ? 'family' : view);
  }
  searchInput.addEventListener('input', () => { hitIndex = 0; renderSearch(); });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { hitIndex = Math.min(hitIndex + 1, hits.length - 1); renderSearch(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hitIndex = Math.max(hitIndex - 1, 0); renderSearch(); e.preventDefault(); }
    else if (e.key === 'Enter' && hits[hitIndex]) pickHit(hits[hitIndex]);
    else if (e.key === 'Escape') { searchInput.value = ''; searchResults.hidden = true; }
  });
  searchInput.addEventListener('blur', () => setTimeout(() => { searchResults.hidden = true; }, 150));

  // ---------- pan & zoom ----------
  let pan = null;
  viewport.addEventListener('pointerdown', (e) => {
    if (!CHART_VIEWS.includes(view) || e.pointerType !== 'mouse' || e.button !== 0) return;
    if (e.target.closest('.pbox, button, input, select, a, .view-bar')) return;
    pan = { x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.classList.add('panning');
    viewport.setPointerCapture(e.pointerId);
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!pan) return;
    viewport.scrollLeft = pan.left - (e.clientX - pan.x);
    viewport.scrollTop = pan.top - (e.clientY - pan.y);
  });
  const endPan = () => { pan = null; viewport.classList.remove('panning'); };
  viewport.addEventListener('pointerup', endPan);
  viewport.addEventListener('pointercancel', endPan);
  viewport.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !CHART_VIEWS.includes(view)) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9));
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selectedId && document.activeElement !== searchInput) { selectedId = null; select(null); }
  });
  window.addEventListener('hashchange', () => { readHash(); render(true); });
  new ResizeObserver(() => drawLines && drawLines()).observe(viewEl);

  // ---------- resizable details panel ----------
  const resizer = $('panel-resizer');
  const PANEL_MIN = 260, PANEL_DEFAULT = 360;
  const panelMax = () => Math.max(PANEL_MIN, Math.min(900, Math.round(window.innerWidth * 0.7)));
  function setPanelWidth(w, save = true) {
    const width = Math.round(Math.min(panelMax(), Math.max(PANEL_MIN, w)));
    detailsEl.style.width = `${width}px`;
    resizer.setAttribute('aria-valuenow', String(width));
    resizer.setAttribute('aria-valuemin', String(PANEL_MIN));
    resizer.setAttribute('aria-valuemax', String(panelMax()));
    if (save) store.write('ft-panel-width', String(width));
  }
  setPanelWidth(Number(store.read('ft-panel-width')) || PANEL_DEFAULT, false);
  let resizing = null;
  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizing = { x: e.clientX, w: detailsEl.offsetWidth };
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
  });
  resizer.addEventListener('pointermove', (e) => {
    if (resizing) setPanelWidth(resizing.w + (resizing.x - e.clientX));
  });
  const stopResize = () => { resizing = null; document.body.classList.remove('resizing'); };
  resizer.addEventListener('pointerup', stopResize);
  resizer.addEventListener('pointercancel', stopResize);
  resizer.addEventListener('dblclick', () => setPanelWidth(PANEL_DEFAULT));
  resizer.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 80 : 20;
    if (e.key === 'ArrowLeft') { setPanelWidth(detailsEl.offsetWidth + step); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { setPanelWidth(detailsEl.offsetWidth - step); e.preventDefault(); }
    else if (e.key === 'Home') { setPanelWidth(PANEL_DEFAULT); e.preventDefault(); }
  });
  window.addEventListener('resize', () => setPanelWidth(detailsEl.offsetWidth || PANEL_DEFAULT, false));

  // ---------- load ----------
  async function load() {
    try {
      const res = await fetch('/api/family');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      people = data.people;
      ({ byId, children } = indexPeople(people));
      document.getElementById('title').textContent = data.title;
      document.title = data.title;
      const years = people.map((p) => Number((/\d{4}/.exec(p.birthDate || '') || [])[0])).filter(Boolean);
      $('stats').textContent = `${people.length} people${years.length ? ` · ${Math.min(...years)}–${Math.max(...years)}` : ''}`;
      view = VIEWS.some(([k]) => k === store.read('ft-view')) ? store.read('ft-view') : 'whole';
      readHash();
      if (!byId.has(focusId) && people.length) focusId = defaultFocus();
      selectedId = null;
      render(true);
    } catch (err) {
      viewEl.replaceChildren(el('div', { className: 'empty-state' }, `Could not load the family tree (${err.message}).`));
    }
  }
  load();
})();
