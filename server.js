'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FamilyStore } = require('./lib/store');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_COOKIE = 'ft_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const PHOTO_NAME = /^[a-f0-9]{32}\.(jpg|png|gif|webp)$/;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const ROUTES = { '/': 'index.html', '/admin': 'admin.html' };

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': MIME_TYPES['.json'], 'Cache-Control': 'no-store', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('That file is too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Works out an image's type from its first bytes, so only real photos are stored. */
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'gif';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function createApp({ dataFile, seedFile, adminPassword, photosDir, backupDir }) {
  if (!adminPassword) throw new Error('adminPassword is required');
  const store = new FamilyStore(dataFile, seedFile, { backupDir });
  const photoDir = photosDir || path.join(path.dirname(dataFile), 'photos');
  const passwordHash = sha256(adminPassword);
  const sessions = new Map();
  const loginAttempts = new Map();

  function currentSession(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expires < Date.now()) {
      sessions.delete(token);
      return null;
    }
    return { token, ...session };
  }

  function tooManyAttempts(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry || entry.reset < now) {
      loginAttempts.set(ip, { count: 1, reset: now + LOGIN_WINDOW_MS });
      return false;
    }
    entry.count += 1;
    return entry.count > LOGIN_MAX_ATTEMPTS;
  }

  async function handleApi(req, res, pathname) {
    const method = req.method;

    if (pathname === '/api/family' && method === 'GET') {
      return sendJson(res, 200, store.getAll());
    }

    if (pathname === '/api/session' && method === 'GET') {
      return sendJson(res, 200, { authenticated: Boolean(currentSession(req)) });
    }

    if (pathname === '/api/login' && method === 'POST') {
      if (tooManyAttempts(req.socket.remoteAddress)) {
        return sendJson(res, 429, { error: 'Too many login attempts. Try again later.' });
      }
      const body = await readJsonBody(req);
      const supplied = typeof body.password === 'string' ? body.password : '';
      if (!crypto.timingSafeEqual(sha256(supplied), passwordHash)) {
        return sendJson(res, 401, { error: 'Incorrect password' });
      }
      loginAttempts.delete(req.socket.remoteAddress);
      const token = crypto.randomBytes(32).toString('hex');
      const csrf = crypto.randomBytes(16).toString('hex');
      sessions.set(token, { csrf, expires: Date.now() + SESSION_TTL_MS });
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return sendJson(res, 200, { authenticated: true, csrf }, {
        'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
      });
    }

    // Everything below requires an authenticated editor.
    const session = currentSession(req);
    if (!session) return sendJson(res, 401, { error: 'Not logged in' });

    if (pathname === '/api/csrf' && method === 'GET') {
      return sendJson(res, 200, { csrf: session.csrf });
    }
    if (req.headers['x-csrf-token'] !== session.csrf) {
      return sendJson(res, 403, { error: 'Invalid CSRF token' });
    }

    if (pathname === '/api/logout' && method === 'POST') {
      sessions.delete(session.token);
      return sendJson(res, 200, { authenticated: false }, {
        'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      });
    }

    if (pathname === '/api/title' && method === 'PUT') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, { title: store.setTitle(body.title) });
    }

    if (pathname === '/api/import' && method === 'POST') {
      return sendJson(res, 200, store.replaceAll(await readJsonBody(req)));
    }

    if (pathname === '/api/photos' && method === 'POST') {
      const buf = await readBody(req, MAX_PHOTO_BYTES);
      const ext = imageType(buf);
      if (!ext) return sendJson(res, 400, { error: 'That file isn\'t a JPEG, PNG, GIF or WebP image' });
      fs.mkdirSync(photoDir, { recursive: true });
      const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(photoDir, name), buf);
      return sendJson(res, 201, { url: `/photos/${name}` });
    }

    if (pathname === '/api/backups' && method === 'GET') {
      return sendJson(res, 200, { backups: store.listBackups() });
    }

    if (pathname === '/api/backups/restore' && method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, store.restoreBackup(body.name));
    }

    if (pathname === '/api/people' && method === 'POST') {
      return sendJson(res, 201, store.create(await readJsonBody(req)));
    }

    const match = pathname.match(/^\/api\/people\/([A-Za-z0-9_-]+)$/);
    if (match) {
      if (method === 'PUT') return sendJson(res, 200, store.update(match[1], await readJsonBody(req)));
      if (method === 'DELETE') {
        store.remove(match[1]);
        return sendJson(res, 204);
      }
    }

    return sendJson(res, 404, { error: 'Not found' });
  }

  function servePhoto(req, res, name) {
    if (!PHOTO_NAME.test(name)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    fs.readFile(path.join(photoDir, name), (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': MIME_TYPES['.' + name.split('.').pop()],
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    });
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    if (pathname.startsWith('/photos/')) return servePhoto(req, res, pathname.slice('/photos/'.length));
    const relative = ROUTES[pathname] || pathname.slice(1);
    const filePath = path.normalize(path.join(PUBLIC_DIR, relative));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    });
  }

  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' https: http: data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    );

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return sendJson(res, 400, { error: 'Bad request' });
    }

    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    try {
      await handleApi(req, res, pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal server error' : err.message });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  let adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    adminPassword = 'changeme';
    console.warn('WARNING: ADMIN_PASSWORD is not set; using the default password "changeme".');
  }
  const server = createApp({
    dataFile: process.env.DATA_FILE || path.join(__dirname, 'data', 'family.json'),
    photosDir: process.env.PHOTOS_DIR,
    backupDir: process.env.BACKUP_DIR,
    seedFile: path.join(__dirname, 'data', 'family.sample.json'),
    adminPassword,
  });
  server.listen(port, () => {
    console.log(`Family tree running at http://localhost:${port}`);
    console.log(`Editor available at http://localhost:${port}/admin`);
  });
}

module.exports = { createApp };
