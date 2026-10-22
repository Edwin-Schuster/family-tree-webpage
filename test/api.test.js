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
