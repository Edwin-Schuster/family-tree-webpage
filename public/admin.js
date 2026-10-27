'use strict';

(() => {
  const { el, fullName, lifespan, byBirth, fmtDate, indexPeople, treeIssues, EVENT_TYPES } = window.FT;
  const $ = (id) => document.getElementById(id);

  const FIELDS = ['firstName', 'lastName', 'maidenName', 'gender', 'birthDate', 'birthPlace',
    'deathDate', 'deathPlace', 'bio'];
  const MAX_PHOTO_SIDE = 2000;

  let csrf = null;
  let data = { title: '', people: [] };
  let editingId = null;
  let relations = { parentIds: [], spouseIds: [] };
  let photoList = [];   // first one is the profile photo
  let events = [];
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
    photoList = [...new Set([person.photoUrl, ...(person.photos || [])].filter(Boolean))];
    events = (person.events || []).map((e) => ({ ...e }));
    $('form-error').textContent = '';
    $('photo-status').textContent = '';
    renderPhotos();
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
    renderEvents();
  }

  // ---------- photos ----------

  function renderPhotos() {
    $('photo-grid').replaceChildren(...photoList.map((src, i) => el('figure', { className: 'photo' + (i === 0 ? ' main' : '') },
      el('img', { src, alt: '' }),
      el('figcaption', {},
        i === 0 ? el('span', {}, 'Profile photo')
          : el('button', { type: 'button', onclick: () => { photoList.splice(i, 1); photoList.unshift(src); dirty = true; renderPhotos(); } }, 'Make profile'),
        el('button', { type: 'button', onclick: () => { photoList.splice(i, 1); dirty = true; renderPhotos(); } }, 'Remove')))));
  }

  /** Shrinks very large photos before upload so the site stays quick. GIFs are sent as they are. */
  async function prepare(file) {
    if (file.type === 'image/gif' || !window.createImageBitmap) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 3 * 1024 * 1024) return file;
      const canvas = el('canvas', { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), 'image/jpeg', 0.88));
    } catch {
      return file;
    }
  }

  async function uploadPhotos(files) {
    let done = 0, failed = 0;
    $('photo-upload-btn').disabled = true;
    for (const file of files) {
      $('photo-status').textContent = `Uploading ${done + failed + 1} of ${files.length}…`;
      try {
        const blob = await prepare(file);
        const res = await fetch('/api/photos', {
          method: 'POST', body: blob, credentials: 'same-origin',
          headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-CSRF-Token': csrf },
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || `Upload failed (${res.status})`);
        photoList.push(payload.url);
        done++;
        dirty = true;
        renderPhotos();
      } catch (err) {
        failed++;
        $('photo-status').textContent = `${file.name}: ${err.message}`;
      }
    }
    $('photo-upload-btn').disabled = false;
    if (!failed) $('photo-status').textContent = `${done} photo${done === 1 ? '' : 's'} added. Save to keep ${done === 1 ? 'it' : 'them'}.`;
  }

  $('photo-upload-btn').addEventListener('click', () => $('photo-file').click());
  $('photo-file').addEventListener('change', () => {
    const files = [...$('photo-file').files];
    $('photo-file').value = '';
    if (files.length) uploadPhotos(files);
  });
  $('photo-link-btn').addEventListener('click', () => {
    const url = $('photo-link').value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) { $('photo-status').textContent = 'Links must start with http:// or https://'; return; }
    photoList.push(url);
    $('photo-link').value = '';
    dirty = true;
    renderPhotos();
  });

  // ---------- life events ----------

  function renderEvents() {
    const spouses = relations.spouseIds.map((id) => byId(id)).filter(Boolean);
    $('events').replaceChildren(...events.map((e, i) => {
      const set = (field) => (ev) => { e[field] = ev.target.value; dirty = true; };
      const couple = e.type === 'Marriage' || e.type === 'Divorce';
      return el('div', { className: 'event-row' },
        el('select', { id: `ev-${i}-type`, 'aria-label': 'Event type', onchange: (ev) => { e.type = ev.target.value; dirty = true; renderEvents(); } },
          EVENT_TYPES.map((t) => el('option', { value: t, selected: e.type === t }, t))),
        el('input', { id: `ev-${i}-date`, 'aria-label': 'Date', placeholder: 'Date, e.g. 1936-05-30', value: e.date || '', maxLength: 40, oninput: set('date') }),
        el('input', { id: `ev-${i}-place`, 'aria-label': 'Place', placeholder: 'Place', value: e.place || '', maxLength: 200, oninput: set('place') }),
        couple
          ? el('select', { id: `ev-${i}-spouse`, 'aria-label': 'Spouse', onchange: set('spouseId') },
            el('option', { value: '' }, spouses.length ? 'Who…' : 'Add a spouse above first'),
            spouses.map((sp) => el('option', { value: sp.id, selected: e.spouseId === sp.id }, fullName(sp))))
          : el('input', { id: `ev-${i}-note`, 'aria-label': 'Details', value: e.note || '', maxLength: 1000,
            placeholder: e.type === 'Occupation' ? 'Job, e.g. Carpenter' : e.type === 'Education' ? 'School or degree' : 'Details', oninput: set('note') }),
        couple ? el('input', { id: `ev-${i}-note`, className: 'span-all', 'aria-label': 'Details', value: e.note || '', maxLength: 1000, placeholder: 'Details (optional)', oninput: set('note') }) : null,
        el('button', { type: 'button', className: 'event-remove', 'aria-label': 'Remove event', onclick: () => { events.splice(i, 1); dirty = true; renderEvents(); } }, 'Remove'));
    }));
  }
  $('event-add').addEventListener('click', () => {
    events.push({ type: 'Occupation', date: '', place: '', note: '', spouseId: '' });
    dirty = true;
    renderEvents();
    const last = $(`ev-${events.length - 1}-type`);
    if (last) last.focus();
  });

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
    body.photoUrl = photoList[0] || '';
    body.photos = photoList.slice(1);
    body.events = events
      .map((e) => ({ type: e.type, date: (e.date || '').trim(), place: (e.place || '').trim(), note: (e.note || '').trim(),
        spouseId: (e.type === 'Marriage' || e.type === 'Divorce') && relations.spouseIds.includes(e.spouseId) ? e.spouseId : '' }))
      .filter((e) => e.date || e.place || e.note || e.spouseId);
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

  // ---------- tool windows: tree check and backups ----------

  function openTool(title, ...content) {
    $('tool-title').textContent = title;
    $('tool-body').replaceChildren(...content.flat().filter(Boolean));
    if (!$('tool-dialog').open) $('tool-dialog').showModal();
  }
  $('tool-close').addEventListener('click', () => $('tool-dialog').close());
  $('tool-dialog').addEventListener('click', (e) => { if (e.target === $('tool-dialog')) $('tool-dialog').close(); });

  const LEVELS = { error: 'Problem', warning: 'Check', info: 'Missing' };
  function showCheck(filter = 'all') {
    const issues = treeIssues(data.people, indexPeople(data.people));
    const counts = Object.fromEntries(Object.keys(LEVELS).map((k) => [k, issues.filter((i) => i.level === k).length]));
    const shown = filter === 'all' ? issues : issues.filter((i) => i.level === filter);
    const chips = el('div', { className: 'check-filters', role: 'group', 'aria-label': 'Show' },
      [['all', `All (${issues.length})`], ...Object.entries(LEVELS).map(([k, t]) => [k, `${t} (${counts[k]})`])].map(([k, t]) =>
        el('button', { type: 'button', className: filter === k ? 'on' : '', 'aria-pressed': String(filter === k), onclick: () => showCheck(k) }, t)));
    openTool('Check the tree',
      el('p', { className: 'muted' }, issues.length
        ? 'Things that look wrong or are missing. Click a name to open them in the editor.'
        : 'Everything looks consistent. No impossible dates or missing details found.'),
      issues.length ? chips : null,
      shown.length ? el('ul', { className: 'issues' }, shown.slice(0, 400).map((it) => el('li', {},
        el('span', { className: `level ${it.level}` }, LEVELS[it.level]),
        el('div', {},
          el('button', { type: 'button', className: 'linkish', onclick: () => { if (!confirmDiscard()) return; $('tool-dialog').close(); edit(it.p.id); } }, fullName(it.p)),
          el('span', { className: 'muted' }, lifespan(it.p) ? ` (${lifespan(it.p)})` : ''),
          el('div', {}, it.text))))) : null,
      shown.length > 400 ? el('p', { className: 'muted' }, `Showing the first 400 of ${shown.length}.`) : null);
  }
  $('check-btn').addEventListener('click', () => showCheck());

  async function showBackups() {
    openTool('Backups', el('p', { className: 'muted' }, 'Loading…'));
    let list;
    try { list = (await api('GET', '/api/backups')).backups; } catch (err) { openTool('Backups', el('p', { className: 'error' }, err.message)); return; }
    const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const why = (name) => name.includes('-restore') ? 'Before a restore' : name.includes('-import') ? 'Before an import' : 'Automatic';
    openTool('Backups',
      el('p', { className: 'muted' }, 'A copy of the tree is saved automatically before changes (at most every 10 minutes), and always before an import or restore. The newest 60 are kept.'),
      list.length ? el('ul', { className: 'backups' }, list.map((b) => el('li', {},
        el('div', {}, el('b', {}, when(b.savedAt)), el('div', { className: 'muted small' }, `${why(b.name)} · ${b.people ?? '?'} people · ${Math.max(1, Math.round(b.size / 1024))} KB`)),
        el('button', { type: 'button', onclick: async () => {
          if (!window.confirm(`Restore the tree as it was on ${when(b.savedAt)}? The current tree is backed up first, so you can undo this.`)) return;
          try {
            await api('POST', '/api/backups/restore', { name: b.name });
            dirty = false;
            await reload();
            startNew();
            toast(`Restored the backup from ${when(b.savedAt)}`);
            showBackups();
          } catch (err) { toast(err.message, true); }
        } }, 'Restore')))) : el('p', {}, 'No backups yet. The first one is made the next time you change something.'));
  }
  $('backups-btn').addEventListener('click', showBackups);

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
