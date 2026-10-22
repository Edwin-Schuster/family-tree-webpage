'use strict';

(() => {
  const { el, fullName, lifespan, avatar, byBirth, indexPeople } = window.FT;

  const treeEl = document.getElementById('tree');
  const detailsEl = document.getElementById('details');
  const rootSelect = document.getElementById('root-select');
  const searchInput = document.getElementById('search');
  const zoomReset = document.getElementById('zoom-reset');

  let people = [];
  let index = { byId: new Map(), children: new Map() };
  let selectedId = null;
  let zoom = 1;

  /**
   * Partners shown beside a person: declared spouses plus anyone they have
   * children with, so co-parents are never missing from the tree.
   */
  function partnersOf(person) {
    const ids = [...person.spouseIds];
    for (const child of index.children.get(person.id)) {
      for (const pid of child.parentIds) {
        if (pid !== person.id && !ids.includes(pid)) ids.push(pid);
      }
    }
    return ids.map((id) => index.byId.get(id)).filter(Boolean);
  }

  /** People who start a branch: no parents, and not married into a family that has parents. */
  function rootPeople() {
    const hasParents = (p) => p.parentIds.some((id) => index.byId.has(id));
    return people
      .filter((p) => !hasParents(p) && !partnersOf(p).some(hasParents))
      .sort(byBirth);
  }

  function personCard(person, { ref = false } = {}) {
    const classes = ['person-card', person.gender];
    if (person.deathDate) classes.push('deceased');
    if (ref) classes.push('ref');
    if (person.id === selectedId) classes.push('selected');
    return el(
      'div',
      {
        className: classes.join(' '),
        tabIndex: 0,
        role: 'button',
        dataset: { id: person.id },
        'aria-label': `${fullName(person)} ${lifespan(person)}`.trim(),
        onclick: () => select(person.id),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            select(person.id);
          }
        },
      },
      avatar(person),
      el('div', { className: 'name' }, fullName(person)),
      el('div', { className: 'dates' }, lifespan(person) || ' '),
      ref ? el('div', { className: 'note' }, 'shown elsewhere') : null,
    );
  }

  /**
   * Renders a person, their partners and (recursively) their descendants.
   * `placed` tracks who already has a branch so shared descendants
   * (e.g. two families joined by marriage) appear only once.
   */
  function renderBranch(person, placed) {
    placed.add(person.id);
    const partners = partnersOf(person);
    const unit = el('div', { className: 'unit' }, personCard(person));
    for (const partner of partners) {
      unit.append(el('span', { className: 'partner-link', 'aria-hidden': 'true' }));
      unit.append(personCard(partner));
      placed.add(partner.id);
    }

    const li = el('li', {}, unit);
    // Children grouped by partner so half-siblings sit together.
    const kids = index.children.get(person.id);
    const ordered = [];
    for (const partner of partners) {
      ordered.push(...kids.filter((k) => k.parentIds.includes(partner.id)));
    }
    ordered.push(...kids.filter((k) => !ordered.includes(k)));

    if (ordered.length) {
      const ul = el('ul');
      for (const child of ordered) {
        if (placed.has(child.id)) {
          ul.append(el('li', {}, el('div', { className: 'unit' }, personCard(child, { ref: true }))));
        } else {
          ul.append(renderBranch(child, placed));
        }
      }
      li.append(ul);
    }
    return li;
  }

  function renderTree() {
    treeEl.replaceChildren();
    if (!people.length) {
      treeEl.append(
        el('div', { className: 'empty-state' },
          el('p', {}, 'No one has been added to the family tree yet.'),
          el('a', { className: 'button', href: '/admin' }, 'Open the editor')),
      );
      return;
    }
    const placed = new Set();
    const startId = rootSelect.value;
    const roots = startId ? [index.byId.get(startId)].filter(Boolean) : rootPeople();
    for (const root of roots) {
      if (placed.has(root.id)) continue;
      treeEl.append(el('ul', {}, renderBranch(root, placed)));
    }
    // Anyone unreachable from a root (e.g. data cycles across partners) still gets shown.
    if (!startId) {
      for (const p of [...people].sort(byBirth)) {
        if (!placed.has(p.id)) treeEl.append(el('ul', {}, renderBranch(p, placed)));
      }
    }
    applySearch();
    // Wide trees overflow sideways; start with the top of the first branch in view.
    const viewport = treeEl.parentElement;
    const firstUnit = treeEl.querySelector('.unit');
    if (firstUnit) {
      const unitBox = firstUnit.getBoundingClientRect();
      const viewBox = viewport.getBoundingClientRect();
      viewport.scrollTop = 0;
      viewport.scrollLeft += unitBox.left + unitBox.width / 2 - (viewBox.left + viewBox.width / 2);
    }
  }

  function relativeList(title, list) {
    if (!list.length) return null;
    return [
      el('h3', {}, title),
      el('ul', { className: 'relative-list' },
        list.map((p) => el('li', {}, el('button', { type: 'button', onclick: () => select(p.id, true) }, fullName(p))))),
    ];
  }

  function renderDetails() {
    const person = index.byId.get(selectedId);
    if (!person) {
      detailsEl.hidden = true;
      return;
    }
    const lookup = (ids) => ids.map((id) => index.byId.get(id)).filter(Boolean);
    const parents = lookup(person.parentIds);
    const siblings = people
      .filter((p) => p.id !== person.id && p.parentIds.some((id) => person.parentIds.includes(id)))
      .sort(byBirth);
    const facts = [
      ['Born', [person.birthDate, person.birthPlace].filter(Boolean).join(', ')],
      ['Died', [person.deathDate, person.deathPlace].filter(Boolean).join(', ')],
      ['Née', person.maidenName],
    ].filter(([, value]) => value);

    const content = [
      el('button', { className: 'close icon', type: 'button', 'aria-label': 'Close details', onclick: () => select(null) }, '×'),
      avatar(person),
      el('h2', {}, fullName(person)),
      el('p', { className: 'subtitle' }, lifespan(person)),
      facts.length ? el('dl', {}, facts.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])) : null,
      person.bio ? el('p', { className: 'bio' }, person.bio) : null,
      relativeList('Parents', parents),
      relativeList('Spouses & partners', partnersOf(person)),
      relativeList('Siblings', siblings),
      relativeList('Children', index.children.get(person.id)),
    ];
    detailsEl.replaceChildren(...content.flat().filter(Boolean));
    detailsEl.hidden = false;
  }

  function select(id, scrollTo = false) {
    selectedId = id;
    for (const card of treeEl.querySelectorAll('.person-card')) {
      card.classList.toggle('selected', card.dataset.id === id);
    }
    renderDetails();
    if (scrollTo && id) scrollToPerson(id);
  }

  function scrollToPerson(id) {
    const card = treeEl.querySelector(`.person-card[data-id="${CSS.escape(id)}"]:not(.ref)`)
      || treeEl.querySelector(`.person-card[data-id="${CSS.escape(id)}"]`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }

  function applySearch() {
    const query = searchInput.value.trim().toLowerCase();
    let first = null;
    for (const card of treeEl.querySelectorAll('.person-card')) {
      const person = index.byId.get(card.dataset.id);
      const haystack = `${fullName(person)} ${person.maidenName}`.toLowerCase();
      const match = Boolean(query) && haystack.includes(query);
      card.classList.toggle('match', match);
      if (match && !first) first = card;
    }
    return first;
  }

  function setZoom(value) {
    zoom = Math.min(2, Math.max(0.3, Math.round(value * 10) / 10));
    treeEl.style.zoom = zoom;
    zoomReset.textContent = `${Math.round(zoom * 100)}%`;
  }

  function populateRootSelect() {
    const current = rootSelect.value;
    rootSelect.replaceChildren(
      el('option', { value: '' }, 'Whole family'),
      ...[...people].sort(byBirth).map((p) => el('option', { value: p.id }, `Descendants of ${fullName(p)}`)),
    );
    if (index.byId.has(current)) rootSelect.value = current;
  }

  async function load() {
    try {
      const res = await fetch('/api/family');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      people = data.people;
      index = indexPeople(people);
      document.getElementById('title').textContent = data.title;
      document.title = data.title;
      populateRootSelect();
      renderTree();
    } catch (err) {
      treeEl.replaceChildren(el('div', { className: 'empty-state' }, `Could not load the family tree (${err.message}).`));
    }
  }

  rootSelect.addEventListener('change', renderTree);
  searchInput.addEventListener('input', () => applySearch());
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = applySearch();
    if (first) {
      first.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      select(first.dataset.id);
    }
  });
  document.getElementById('zoom-in').addEventListener('click', () => setZoom(zoom + 0.1));
  document.getElementById('zoom-out').addEventListener('click', () => setZoom(zoom - 0.1));
  zoomReset.addEventListener('click', () => setZoom(1));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selectedId) select(null);
  });

  load();
})();
