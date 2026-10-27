'use strict';

/* Helpers shared by the public tree page and the editor. */
window.FT = (() => {
  /** Tiny DOM builder: el('div', { className: 'x', onclick }, child, 'text'). */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function fullName(p) {
    return [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Unnamed';
  }

  function year(date) {
    const match = /\d{4}/.exec(date || '');
    return match ? match[0] : '';
  }

  function lifespan(p) {
    const born = year(p.birthDate);
    const died = year(p.deathDate);
    if (!born && !died) return '';
    if (!died) return p.deathDate ? `${born || '?'} – ?` : `b. ${born}`;
    return `${born || '?'} – ${died}`;
  }

  function initials(p) {
    return ((p.firstName || '').charAt(0) + (p.lastName || '').charAt(0)).toUpperCase() || '?';
  }

  function avatar(p) {
    const box = el('div', { className: `avatar${p.gender ? ' ' + p.gender : ''}`, 'aria-hidden': 'true' });
    const src = p.photoUrl || (p.photos && p.photos[0]);
    if (src) {
      const img = el('img', { src, alt: '', loading: 'lazy' });
      img.addEventListener('error', () => img.replaceWith(initials(p)));
      box.append(img);
    } else {
      box.textContent = initials(p);
    }
    return box;
  }

  /** Sort key that puts people with known birth dates first, oldest first. */
  function byBirth(a, b) {
    const ya = a.birthDate || '9999';
    const yb = b.birthDate || '9999';
    return ya.localeCompare(yb) || fullName(a).localeCompare(fullName(b));
  }

  function indexPeople(people) {
    const byId = new Map(people.map((p) => [p.id, p]));
    const children = new Map(people.map((p) => [p.id, []]));
    for (const p of people) {
      for (const pid of p.parentIds) children.get(pid)?.push(p);
    }
    for (const list of children.values()) list.sort(byBirth);
    return { byId, children };
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const EVENT_TYPES = ['Marriage', 'Divorce', 'Occupation', 'Education', 'Residence', 'Census', 'Military service',
    'Immigration', 'Naturalization', 'Baptism', 'Burial', 'Other'];

  /** "1910-10-19" -> "19 Oct 1910", "1852-09" -> "September 1852"; anything else is shown as typed. */
  function fmtDate(d) {
    if (!d) return '';
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (m && +m[2] >= 1 && +m[2] <= 12) return `${+m[3]} ${MONTHS[+m[2] - 1].slice(0, 3)} ${m[1]}`;
    m = /^(\d{4})-(\d{2})$/.exec(d);
    if (m && +m[2] >= 1 && +m[2] <= 12) return `${MONTHS[+m[2] - 1]} ${m[1]}`;
    m = /^(c\.|bef\.|aft\.) (\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(d);
    if (m) return `${m[1]} ${fmtDate(m[2] + '-' + m[3] + (m[4] ? '-' + m[4] : ''))}`;
    return d;
  }
  function isoParts(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  const yearNum = (d) => { const m = /\d{4}/.exec(d || ''); return m ? +m[0] : null; };
  const THIS_YEAR = new Date().getFullYear();
  function isLiving(p) {
    if (p.deathDate) return false;
    const b = yearNum(p.birthDate);
    return !b || THIS_YEAR - b < 105;
  }

  /** Marriage (and divorce) events between two people, wherever they were recorded. */
  function coupleEvents(a, b) {
    const out = [];
    for (const [x, y] of [[a, b], [b, a]]) {
      for (const e of x.events || []) {
        if ((e.type === 'Marriage' || e.type === 'Divorce') && e.spouseId === y.id
          && !out.some((o) => o.type === e.type && o.date === e.date)) out.push(e);
      }
    }
    return out;
  }

  // ---------- relationship calculator ----------
  function ancestry(id, byId) {
    const depth = new Map([[id, 0]]);
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift();
      for (const pid of byId.get(cur).parentIds) {
        if (byId.has(pid) && !depth.has(pid)) { depth.set(pid, depth.get(cur) + 1); queue.push(pid); }
      }
    }
    return depth;
  }
  const greats = (k) => (k <= 0 ? '' : k === 1 ? 'great-' : k === 2 ? 'great-great-' : `${k}× great-`);
  const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th');
  const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
  const g3 = (p, m, f, o) => (p.gender === 'male' ? m : p.gender === 'female' ? f : o);

  function bloodRelation(a, b, byId, wordsFor = a) {
    const A = ancestry(a.id, byId), B = ancestry(b.id, byId);
    let best = null;
    for (const [id, da] of A) {
      if (B.has(id) && (!best || da + B.get(id) < best.da + best.db)) best = { da, db: B.get(id) };
    }
    if (!best) return null;
    const { da, db } = best;
    const commons = [...A.keys()].filter((id) => B.has(id) && A.get(id) === da && B.get(id) === db);
    const w = wordsFor;
    let word;
    if (da === 0) word = db === 1 ? g3(w, 'father', 'mother', 'parent') : greats(db - 2) + g3(w, 'grandfather', 'grandmother', 'grandparent');
    else if (db === 0) word = da === 1 ? g3(w, 'son', 'daughter', 'child') : greats(da - 2) + g3(w, 'grandson', 'granddaughter', 'grandchild');
    else if (da === 1 && db === 1) {
      const shared = a.parentIds.filter((x) => b.parentIds.includes(x)).length;
      word = (shared === 1 && a.parentIds.length === 2 && b.parentIds.length === 2 ? 'half-' : '') + g3(w, 'brother', 'sister', 'sibling');
    } else if (da === 1) word = greats(db - 2) + g3(w, 'uncle', 'aunt', 'aunt or uncle');
    else if (db === 1) word = (da === 2 ? '' : greats(da - 3) + 'grand') + g3(w, 'nephew', 'niece', 'niece or nephew');
    else {
      const n = Math.min(da, db) - 1, r = Math.abs(da - db);
      word = `${ordinal(n)} cousin` + (r ? ` ${times(r)} removed` : '');
    }
    return { word, commons, da, db };
  }

  /**
   * How `a` is related to `b`, e.g. { word: "great-granddaughter" }.
   * `far: true` means only a general answer ("related by marriage") could be found.
   */
  function relationship(a, b, { byId, children }) {
    if (a.id === b.id) return { word: 'the same person', same: true };
    if (a.spouseIds.includes(b.id)) return { word: g3(a, 'husband', 'wife', 'spouse') };
    const direct = bloodRelation(a, b, byId);
    if (direct) return direct;
    for (const s of b.spouseIds.map((id) => byId.get(id)).filter(Boolean)) {
      const r = bloodRelation(a, s, byId);
      if (!r) continue;
      if (r.da === 0 && r.db === 1) return { word: g3(a, 'father-in-law', 'mother-in-law', 'parent-in-law') };
      if (r.da === 1 && r.db === 1) return { word: g3(a, 'brother-in-law', 'sister-in-law', 'sibling-in-law') };
      if (r.da === 1 && r.db === 0) return { word: g3(a, 'stepson', 'stepdaughter', 'stepchild') };
      return { word: `${r.word} by marriage`, marriage: true };
    }
    for (const s of a.spouseIds.map((id) => byId.get(id)).filter(Boolean)) {
      const r = bloodRelation(s, b, byId, a);
      if (!r) continue;
      if (r.da === 1 && r.db === 1) return { word: g3(a, 'brother-in-law', 'sister-in-law', 'sibling-in-law') };
      if (r.da === 1 && r.db === 0) return { word: g3(a, 'son-in-law', 'daughter-in-law', 'child-in-law') };
      if (r.da === 0 && r.db === 1) return { word: g3(a, 'stepfather', 'stepmother', 'stepparent') };
      if (r.da && r.db) return { word: `${r.word} by marriage`, marriage: true };
    }
    const seen = new Set([a.id]);
    const queue = [a.id];
    while (queue.length) {
      const c = byId.get(queue.shift());
      for (const n of [...c.parentIds, ...c.spouseIds, ...(children.get(c.id) || []).map((k) => k.id)]) {
        if (byId.has(n) && !seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
    return seen.has(b.id) ? { word: 'related by marriage', far: true } : { word: 'not connected in this tree', far: true, none: true };
  }

  // ---------- tree check ----------
  /** Things worth a second look: impossible dates, missing details, likely duplicates. */
  function treeIssues(people, { byId, children }) {
    const out = [];
    const add = (level, p, text) => out.push({ level, p, text });
    const seen = new Map();
    for (const p of people) {
      const b = yearNum(p.birthDate), d = yearNum(p.deathDate);
      if (b && d && d < b) add('error', p, 'Died before they were born.');
      if (b && b > THIS_YEAR) add('error', p, 'Birth year is in the future.');
      if (b && d && d - b > 110) add('warning', p, `Lived ${d - b} years. Check the dates.`);
      if (b && !p.deathDate && THIS_YEAR - b >= 105) add('warning', p, `Born ${b} with no death date. Add one if they have died.`);
      for (const par of p.parentIds.map((id) => byId.get(id)).filter(Boolean)) {
        const pb = yearNum(par.birthDate), pd = yearNum(par.deathDate);
        if (b && pb && b - pb < 13) add('error', p, `Born when ${fullName(par)} was ${b - pb < 0 ? 'not yet born' : b - pb}.`);
        else if (b && pb && b - pb > (par.gender === 'female' ? 55 : 75)) add('warning', p, `Born when ${fullName(par)} was ${b - pb}.`);
        if (b && pd && b > pd + (par.gender === 'female' ? 0 : 1)) add('error', p, `Born after ${fullName(par)} died (${pd}).`);
      }
      if (!p.gender) add('info', p, 'Gender isn’t set, so the tree calls them “child”, “sibling” or “parent” instead of son, sister, mother.');
      if (p.parentIds.length === 1) {
        const par = byId.get(p.parentIds[0]);
        if (par && par.spouseIds.length) add('info', p, `Only one parent is recorded. ${fullName(par)} has ${par.spouseIds.length === 1 ? 'a partner' : 'partners'} in the tree who may be the other parent.`);
      }
      if (!p.parentIds.length && !p.spouseIds.length && !(children.get(p.id) || []).length && people.length > 1) add('info', p, 'Not linked to anyone in the tree.');
      if (!p.birthDate && !p.deathDate) add('info', p, 'No birth or death date.');
      const key = `${fullName(p).toLowerCase()}|${b || ''}`;
      if (seen.has(key) && b) add('warning', p, `Possible duplicate of another ${fullName(p)} born ${b}.`);
      else seen.set(key, p);
    }
    const order = { error: 0, warning: 1, info: 2 };
    return out.sort((x, y) => order[x.level] - order[y.level] || fullName(x.p).localeCompare(fullName(y.p)));
  }

  return { el, fullName, year, lifespan, initials, avatar, byBirth, indexPeople, fmtDate, isoParts, yearNum, isLiving,
    coupleEvents, relationship, treeIssues, EVENT_TYPES, MONTHS };
})();
