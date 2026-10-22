'use strict';

(() => {
  const { el, fullName, lifespan, byBirth } = window.FT;
  const $ = (id) => document.getElementById(id);

  const FIELDS = ['firstName', 'lastName', 'maidenName', 'gender', 'birthDate', 'birthPlace',
    'deathDate', 'deathPlace', 'photoUrl', 'bio'];

  let csrf = null;
  let data = { title: '', people: [] };
  let editingId = null;
  let relations = { parentIds: [], spouseIds: [] };
  // Set when "Add parent" is used: once the new person is saved they're linked as this child's parent.
  let pendingParentOf = null;
  let dirty = false;

  // ---------- API ----------

  async function api(method, url, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    if (res.status === 401 && url !== '/api/login') {
      showLogin();
      throw new Error('Your session has expired. Please log in again.');
    }
    const payload = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error(payload?.error || `Request failed (${res.status})`);
    return payload;
  }

  let toastTimer;
  function toast(message, isError = false) {
    const node = $('toast');
    node.textContent = message;
    node.classList.toggle('error-toast', isError);
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 5000 : 2500);
  }

  // ---------- Login ----------

  function showLogin() {
    csrf = null;
    $('editor-view').hidden = true;
    $('login-view').hidden = false;
    $('password').focus();
  }

  async function showEditor() {
    $('login-view').hidden = true;
    $('editor-view').hidden = false;
    await reload();
    startNew();
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    try {
      const result = await api('POST', '/api/login', { password: $('password').value });
      csrf = result.csrf;
      $('password').value = '';
      await showEditor();
    } catch (err) {
      $('login-error').textContent = err.message;
    }
  });

  $('logout-btn').addEventListener('click', async () => {
    if (!confirmDiscard()) return;
    try {
      await api('POST', '/api/logout');
    } finally {
      showLogin();
    }
  });

  // ---------- People list ----------

  const byId = (id) => data.people.find((p) => p.id === id);

  function sortedPeople() {
    return [...data.people].sort((a, b) =>
      (a.lastName || '').localeCompare(b.lastName || '') || byBirth(a, b));
  }

  function label(p) {
    const span = lifespan(p);
    return span ? `${fullName(p)} (${span})` : fullName(p);
  }

  function renderList() {
    const query = $('filter').value.trim().toLowerCase();
    const matches = sortedPeople().filter((p) =>
      `${fullName(p)} ${p.maidenName}`.toLowerCase().includes(query));
    $('count').textContent = `${matches.length} of ${data.people.length} people`;
    $('people-list').replaceChildren(...matches.map((p) =>
      el('li', {},
        el('button', {
          type: 'button',
          className: p.id === editingId ? 'active' : '',
          onclick: () => { if (confirmDiscard()) edit(p.id); },
        },
        el('span', {}, fullName(p)),
        el('span', { className: 'years' }, lifespan(p))))));
  }

  async function reload() {
    data = await api('GET', '/api/family');
    $('site-title').value = data.title;
    renderList();
  }

  // ---------- Form ----------

  function confirmDiscard() {
    return !dirty || window.confirm('You have unsaved changes. Discard them?');
  }

  function fillForm(person) {
    for (const field of FIELDS) $(field).value = person[field] || '';
    relations = { parentIds: [...(person.parentIds || [])], spouseIds: [...(person.spouseIds || [])] };
    $('form-error').textContent = '';
    renderRelations();
    dirty = false;
  }

  function startNew(preset = {}, note = '') {
    editingId = null;
    pendingParentOf = preset.pendingParentOf || null;
    fillForm(preset);
    $('form-heading').textContent = 'Add a person';
    $('quick-actions').hidden = true;
    $('delete-btn').hidden = true;
    $('pending-note').hidden = !note;
    $('pending-note').textContent = note;
    renderList();
    $('firstName').focus();
  }

  function edit(id) {
    const person = byId(id);
    if (!person) return startNew();
    editingId = id;
    pendingParentOf = null;
    fillForm(person);
    $('form-heading').textContent = `Edit ${fullName(person)}`;
    $('quick-actions').hidden = false;
    $('add-parent').disabled = person.parentIds.length >= 2;
    $('delete-btn').hidden = false;
    $('pending-note').hidden = true;
    renderList();
  }

  function renderChips(containerId, ids, field) {
    $(containerId).replaceChildren(...ids.map((id) => {
      const p = byId(id);
      return el('span', { className: 'chip' },
        p ? label(p) : 'Unknown person',
        el('button', {
          type: 'button',
          'aria-label': `Remove ${p ? fullName(p) : 'person'}`,
          onclick: () => {
            relations[field] = relations[field].filter((x) => x !== id);
            dirty = true;
            renderRelations();
          },
        }, '×'));
    }));
  }

  /** Ids that would make a cycle if chosen as a parent: the person and all their descendants. */
  function descendantsOf(id) {
    const result = new Set([id]);
    const stack = [id];
    while (stack.length) {
      const current = stack.pop();
      for (const p of data.people) {
        if (p.parentIds.includes(current) && !result.has(p.id)) {
          result.add(p.id);
          stack.push(p.id);
        }
      }
    }
    return result;
  }

  function fillSelect(selectId, exclude, placeholder) {
    const options = sortedPeople().filter((p) => !exclude.has(p.id));
    $(selectId).replaceChildren(
      el('option', { value: '' }, options.length ? placeholder : 'No one available'),
      ...options.map((p) => el('option', { value: p.id }, label(p))),
    );
  }

  function renderRelations() {
    renderChips('parent-chips', relations.parentIds, 'parentIds');
    renderChips('spouse-chips', relations.spouseIds, 'spouseIds');

    const parentExclude = editingId ? descendantsOf(editingId) : new Set();
    relations.parentIds.forEach((id) => parentExclude.add(id));
    fillSelect('parent-add', parentExclude, 'Choose a parent…');
    const full = relations.parentIds.length >= 2;
    $('parent-add').disabled = full;
    $('parent-add-btn').disabled = full;

    const spouseExclude = new Set(relations.spouseIds);
    if (editingId) spouseExclude.add(editingId);
    fillSelect('spouse-add', spouseExclude, 'Choose a spouse or partner…');
  }

  function addRelation(field, selectId) {
    const id = $(selectId).value;
    if (!id) return;
    relations[field].push(id);
    dirty = true;
    renderRelations();
  }

  $('parent-add-btn').addEventListener('click', () => addRelation('parentIds', 'parent-add'));
  $('spouse-add-btn').addEventListener('click', () => addRelation('spouseIds', 'spouse-add'));
  $('person-form').addEventListener('input', () => { dirty = true; });

  $('person-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('form-error').textContent = '';
    const body = { ...relations };
    for (const field of FIELDS) body[field] = $(field).value;
    $('save-btn').disabled = true;
    try {
      const saved = editingId
        ? await api('PUT', `/api/people/${encodeURIComponent(editingId)}`, body)
        : await api('POST', '/api/people', body);
      if (pendingParentOf) {
        const child = byId(pendingParentOf);
        if (child && child.parentIds.length < 2) {
          await api('PUT', `/api/people/${encodeURIComponent(child.id)}`, {
            parentIds: [...child.parentIds, saved.id],
          });
        }
      }
      dirty = false;
      await reload();
      edit(saved.id);
      toast(`Saved ${fullName(saved)}`);
    } catch (err) {
      $('form-error').textContent = err.message;
    } finally {
      $('save-btn').disabled = false;
    }
  });

  $('cancel-btn').addEventListener('click', () => {
    if (!confirmDiscard()) return;
    if (editingId) edit(editingId);
    else startNew();
  });

  $('delete-btn').addEventListener('click', async () => {
    const person = byId(editingId);
    if (!person) return;
    if (!window.confirm(`Delete ${fullName(person)}? Their relationships to others will also be removed.`)) return;
    try {
      await api('DELETE', `/api/people/${encodeURIComponent(person.id)}`);
      dirty = false;
      await reload();
      startNew();
      toast(`Deleted ${fullName(person)}`);
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('new-btn').addEventListener('click', () => { if (confirmDiscard()) startNew(); });
  $('filter').addEventListener('input', renderList);

  // ---------- Quick relationship actions ----------

  $('add-child').addEventListener('click', () => {
    const person = byId(editingId);
    if (!person || !confirmDiscard()) return;
    const parentIds = [person.id];
    if (person.spouseIds.length === 1) parentIds.push(person.spouseIds[0]);
    startNew({ parentIds, lastName: person.lastName }, `Adding a child of ${fullName(person)}.`);
  });

  $('add-spouse').addEventListener('click', () => {
    const person = byId(editingId);
    if (!person || !confirmDiscard()) return;
    startNew({ spouseIds: [person.id] }, `Adding a spouse or partner of ${fullName(person)}.`);
  });

  $('add-parent').addEventListener('click', () => {
    const person = byId(editingId);
    if (!person || !confirmDiscard()) return;
    const preset = { pendingParentOf: person.id, spouseIds: [...person.parentIds] };
    startNew(preset, `Adding a parent of ${fullName(person)}.`);
  });

  // ---------- Title, import & export ----------

  $('title-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const result = await api('PUT', '/api/title', { title: $('site-title').value });
      data.title = result.title;
      toast('Title updated');
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = el('a', { href: URL.createObjectURL(blob), download: 'family-tree.json' });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  });

  $('import-btn').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files[0];
    $('import-file').value = '';
    if (!file) return;
    if (!window.confirm('Importing replaces everyone currently in the tree. Continue?')) return;
    try {
      const parsed = JSON.parse(await file.text());
      await api('POST', '/api/import', parsed);
      dirty = false;
      await reload();
      startNew();
      toast(`Imported ${data.people.length} people`);
    } catch (err) {
      toast(`Import failed: ${err.message}`, true);
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });

  // ---------- Boot ----------

  (async () => {
    try {
      const session = await api('GET', '/api/session');
      if (!session.authenticated) return showLogin();
      csrf = (await api('GET', '/api/csrf')).csrf;
      await showEditor();
    } catch {
      showLogin();
    }
  })();
})();
