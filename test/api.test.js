'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

const PASSWORD = 'test-password';
let server;
let baseUrl;
let tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-tree-'));
  server = createApp({
    dataFile: path.join(tmpDir, 'family.json'),
    seedFile: path.join(__dirname, '..', 'data', 'family.sample.json'),
    adminPassword: PASSWORD,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function request(method, url, { body, cookie, csrf } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(baseUrl + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

async function login() {
  const res = await request('POST', '/api/login', { body: { password: PASSWORD } });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { cookie, csrf: res.body.csrf };
}

test('public endpoint returns seeded family data', async () => {
  const res = await request('GET', '/api/family');
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'The Whitaker Family Tree');
  assert.ok(res.body.people.length >= 10);
});

test('serves the tree page and editor page', async () => {
  for (const url of ['/', '/admin', '/tree.js', '/styles.css']) {
    const res = await fetch(baseUrl + url);
    assert.equal(res.status, 200, url);
  }
});

test('blocks path traversal', async () => {
  const res = await fetch(`${baseUrl}/..%2Fserver.js`);
  assert.equal(res.status, 403);
});

test('rejects a wrong password', async () => {
  const res = await request('POST', '/api/login', { body: { password: 'nope' } });
  assert.equal(res.status, 401);
});

test('write endpoints require login and a CSRF token', async () => {
  const anon = await request('POST', '/api/people', { body: { firstName: 'X' } });
  assert.equal(anon.status, 401);

  const { cookie } = await login();
  const noCsrf = await request('POST', '/api/people', { body: { firstName: 'X' }, cookie });
  assert.equal(noCsrf.status, 403);
});

test('create, update and delete a person', async () => {
  const auth = await login();

  const created = await request('POST', '/api/people', {
    ...auth,
    body: { firstName: 'Ada', lastName: 'Whitaker', parentIds: ['p7'], spouseIds: [] },
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.deepEqual(created.body.parentIds, ['p7']);

  const updated = await request('PUT', `/api/people/${id}`, { ...auth, body: { bio: 'Hello', spouseIds: ['p8'] } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.bio, 'Hello');
  assert.equal(updated.body.firstName, 'Ada', 'partial update keeps other fields');

  let family = (await request('GET', '/api/family')).body;
  assert.ok(family.people.find((p) => p.id === 'p8').spouseIds.includes(id), 'spouse link is mirrored');

  const removed = await request('DELETE', `/api/people/${id}`, auth);
  assert.equal(removed.status, 204);
  family = (await request('GET', '/api/family')).body;
  assert.ok(!family.people.some((p) => p.id === id));
  assert.ok(!family.people.find((p) => p.id === 'p8').spouseIds.includes(id), 'references are cleaned up');
});

test('validates input', async () => {
  const auth = await login();
  const cases = [
    { firstName: '', lastName: '' },
    { firstName: 'A', parentIds: ['missing'] },
    { firstName: 'A', parentIds: ['p1', 'p2', 'p3'] },
    { firstName: 'A', photoUrl: 'javascript:alert(1)' },
    { firstName: 'A', gender: 'robot' },
  ];
  for (const body of cases) {
    const res = await request('POST', '/api/people', { ...auth, body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('prevents ancestry cycles', async () => {
  const auth = await login();
  // p1 is the grandparent of p7, so p7 cannot become p1's parent.
  const res = await request('PUT', '/api/people/p1', { ...auth, body: { parentIds: ['p7'] } });
  assert.equal(res.status, 400);
});

test('import replaces data and export round-trips', async () => {
  const auth = await login();
  const original = (await request('GET', '/api/family')).body;

  const imported = await request('POST', '/api/import', {
    ...auth,
    body: {
      title: 'Imported',
      people: [
        { id: 'a', firstName: 'Ann', spouseIds: ['b'] },
        { id: 'b', firstName: 'Bob' },
        { id: 'c', firstName: 'Cy', parentIds: ['a', 'b', 'ghost'] },
      ],
    },
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.people.length, 3);
  assert.deepEqual(imported.body.people.find((p) => p.id === 'b').spouseIds, ['a']);
  assert.deepEqual(imported.body.people.find((p) => p.id === 'c').parentIds, ['a', 'b']);

  const restored = await request('POST', '/api/import', { ...auth, body: original });
  assert.equal(restored.status, 200);
  assert.deepEqual((await request('GET', '/api/family')).body, original);
});

test('logout invalidates the session', async () => {
  const auth = await login();
  assert.equal((await request('POST', '/api/logout', auth)).status, 200);
  const res = await request('GET', '/api/csrf', auth);
  assert.equal(res.status, 401);
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

async function upload(auth, buf, type) {
  const res = await fetch(`${baseUrl}/api/photos`, {
    method: 'POST', body: buf, headers: { 'Content-Type': type, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf },
  });
  return { status: res.status, body: await res.json() };
}

test('uploads photos and serves them back', async () => {
  const auth = await login();
  const res = await upload(auth, PNG, 'image/png');
  assert.equal(res.status, 201);
  assert.match(res.body.url, /^\/photos\/[a-f0-9]{32}\.png$/);
  const img = await fetch(baseUrl + res.body.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);

  const saved = await request('PUT', '/api/people/p1', { ...auth, body: { photoUrl: res.body.url, photos: ['https://example.com/a.jpg'] } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.photos, ['https://example.com/a.jpg']);
});

test('rejects uploads that are not images, and anonymous uploads', async () => {
  const auth = await login();
  assert.equal((await upload(auth, Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml')).status, 400);
  const anon = await fetch(`${baseUrl}/api/photos`, { method: 'POST', body: PNG, headers: { 'Content-Type': 'image/png' } });
  assert.equal(anon.status, 401);
  assert.equal((await fetch(`${baseUrl}/photos/../family.json`)).status, 404);
});

test('stores life events and validates them', async () => {
  const auth = await login();
  const ok = await request('PUT', '/api/people/p1', { ...auth, body: { events: [
    { type: 'Marriage', date: '1947-06-21', place: 'York, England', spouseId: 'p2' },
    { type: 'Occupation', note: 'Carpenter' },
  ] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.events.length, 2);
  assert.equal(ok.body.events[1].spouseId, '');

  for (const events of [[{ type: 'Party' }], [{ type: 'Marriage', spouseId: 'nobody' }], 'nope']) {
    const res = await request('PUT', '/api/people/p1', { ...auth, body: { events } });
    assert.equal(res.status, 400, JSON.stringify(events));
  }
});

test('backs up before an import and can restore it', async () => {
  const auth = await login();
  const before = (await request('GET', '/api/family')).body;
  await request('POST', '/api/import', { ...auth, body: { title: 'Tiny', people: [{ id: 'x', firstName: 'Solo' }] } });
  assert.equal((await request('GET', '/api/family')).body.people.length, 1);

  const { body } = await request('GET', '/api/backups', auth);
  const importBackup = body.backups.find((b) => b.name.includes('-import'));
  assert.ok(importBackup, 'an import backup exists');
  assert.equal(importBackup.people, before.people.length);

  const restored = await request('POST', '/api/backups/restore', { ...auth, body: { name: importBackup.name } });
  assert.equal(restored.status, 200);
  assert.deepEqual((await request('GET', '/api/family')).body, before);

  const bad = await request('POST', '/api/backups/restore', { ...auth, body: { name: '../family.json' } });
  assert.equal(bad.status, 400);
});

const { buildCalendar, fold } = require('../lib/calendar');

test('calendar feed lists yearly birthdays and anniversaries', async () => {
  const res = await fetch(`${baseUrl}/calendar.ics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/calendar/);
  const body = await res.text();
  assert.ok(body.startsWith('BEGIN:VCALENDAR\r\n') && body.endsWith('END:VCALENDAR\r\n'));
  assert.match(body, /SUMMARY:🎂 Robert Whitaker’s birthday/);          // living
  assert.doesNotMatch(body, /Harold Whitaker’s birthday/);              // died 1998
  assert.match(body, /RRULE:FREQ=YEARLY/);
  for (const line of body.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
});

test('calendar builder handles weddings, remembrance, leap days and escaping', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  const data = { title: 'Test, Family', people: [
    { id: 'a', firstName: 'Ann', lastName: 'Lee', birthDate: '1960-02-29', events: [{ type: 'Marriage', date: '1985-06-01', place: 'Ohio; USA', spouseId: 'b' }] },
    { id: 'b', firstName: 'Bob', lastName: 'Lee', birthDate: '1958-03-03', events: [{ type: 'Marriage', date: '1985-06-01', spouseId: 'a' }] },
    { id: 'c', firstName: 'Cy', lastName: 'Lee', birthDate: '1900-01-01', deathDate: '1970-05-05', events: [] },
  ] };
  const unfold = (t) => t.replace(/\r\n /g, '');
  const plain = unfold(buildCalendar(data, { now }).body);
  assert.equal((plain.match(/BEGIN:VEVENT/g) || []).length, 3, 'two birthdays + one shared wedding');
  assert.match(plain, /BYMONTH=2;BYMONTHDAY=-1/);
  assert.match(plain, /X-WR-CALNAME:Test\\, Family/);
  assert.match(plain, /in Ohio\\; USA/);
  assert.doesNotMatch(plain, /Remembering/);
  const all = unfold(buildCalendar(data, { now, remembrance: true }).body);
  assert.match(all, /Remembering Cy Lee/);
  assert.equal(fold('x'.repeat(200)).split('\r\n ').map((l) => l.length).join(','), '75,74,51');
});
