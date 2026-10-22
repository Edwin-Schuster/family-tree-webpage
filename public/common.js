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
    const box = el('div', { className: 'avatar', 'aria-hidden': 'true' });
    if (p.photoUrl) {
      const img = el('img', { src: p.photoUrl, alt: '', loading: 'lazy' });
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

  return { el, fullName, year, lifespan, initials, avatar, byBirth, indexPeople };
})();
