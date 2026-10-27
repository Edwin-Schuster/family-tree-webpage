'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEXT_FIELDS = {
  firstName: 100,
  lastName: 100,
  maidenName: 100,
  birthDate: 40,
  birthPlace: 200,
  deathDate: 40,
  deathPlace: 200,
  photoUrl: 2000,
  bio: 8000,
};
const GENDERS = ['male', 'female', 'other', ''];
const EVENT_TYPES = ['Marriage', 'Divorce', 'Occupation', 'Education', 'Residence', 'Census', 'Military service',
  'Immigration', 'Naturalization', 'Baptism', 'Burial', 'Other'];
const EVENT_FIELDS = { date: 40, place: 200, note: 1000 };
const MAX_EVENTS = 100;
const MAX_PHOTOS = 40;
const BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const BACKUPS_KEPT = 60;
const BACKUP_NAME = /^family-\d{8}-\d{6}(?:-[a-z]+)?(?:-\d+)?\.json$/;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.status = 404;
  }
}

function uniqueIds(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ValidationError(`${field} must be an array of person ids`);
  }
  return [...new Set(value)];
}

function isSafeUrl(url) {
  if (url === '') return true;
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function sanitizeEvents(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError('events must be an array');
  if (value.length > MAX_EVENTS) throw new ValidationError(`A person can have at most ${MAX_EVENTS} events`);
  return value.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError(`Event ${i + 1} must be an object`);
    const type = raw.type == null || raw.type === '' ? 'Other' : raw.type;
    if (!EVENT_TYPES.includes(type)) throw new ValidationError(`Event ${i + 1} has an unknown type: ${type}`);
    const event = { type };
    for (const [field, max] of Object.entries(EVENT_FIELDS)) {
      const v = raw[field] == null ? '' : raw[field];
      if (typeof v !== 'string') throw new ValidationError(`Event ${i + 1} ${field} must be text`);
      if (v.trim().length > max) throw new ValidationError(`Event ${i + 1} ${field} must be at most ${max} characters`);
      event[field] = v.trim();
    }
    const spouseId = raw.spouseId == null ? '' : raw.spouseId;
    if (typeof spouseId !== 'string') throw new ValidationError(`Event ${i + 1} spouseId must be a person id`);
    event.spouseId = spouseId;
    return event;
  });
}

function sanitizePhotos(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new ValidationError('photos must be a list of links');
  const photos = [...new Set(value.map((v) => v.trim()).filter(Boolean))];
  if (photos.length > MAX_PHOTOS) throw new ValidationError(`A person can have at most ${MAX_PHOTOS} photos`);
  for (const url of photos) {
    if (url.length > 2000 || !isSafeUrl(url)) throw new ValidationError('Each photo must be an http(s) link or an uploaded photo');
  }
  return photos;
}

/**
 * Normalises and validates user input for a person. `existing` supplies
 * defaults for fields omitted from a partial update.
 */
function sanitizePerson(input, existing = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Request body must be a JSON object');
  }
  const person = { id: existing.id };

  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    const raw = field in input ? input[field] : existing[field];
    if (raw === undefined || raw === null) {
      person[field] = '';
      continue;
    }
    if (typeof raw !== 'string') throw new ValidationError(`${field} must be a string`);
    const value = raw.trim();
    if (value.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
    person[field] = value;
  }

  if (!person.firstName && !person.lastName) {
    throw new ValidationError('A first or last name is required');
  }
  if (!isSafeUrl(person.photoUrl)) {
    throw new ValidationError('photoUrl must be an http(s) URL or a site-relative path');
  }

  const gender = 'gender' in input ? input.gender : existing.gender;
  person.gender = gender == null ? '' : gender;
  if (!GENDERS.includes(person.gender)) {
    throw new ValidationError(`gender must be one of: ${GENDERS.filter(Boolean).join(', ')}`);
  }

  person.parentIds = uniqueIds('parentIds' in input ? input.parentIds : existing.parentIds, 'parentIds');
  person.spouseIds = uniqueIds('spouseIds' in input ? input.spouseIds : existing.spouseIds, 'spouseIds');
  person.photos = sanitizePhotos('photos' in input ? input.photos : existing.photos);
  person.events = sanitizeEvents('events' in input ? input.events : existing.events);
  return person;
}

function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

class FamilyStore {
  /**
   * @param {string} filePath where the tree is saved
   * @param {string} [seedPath] data loaded on first run
   * @param {{backupDir?: string}} [options] backups go here before changes (default: <data dir>/backups)
   */
  constructor(filePath, seedPath, options = {}) {
    this.filePath = filePath;
    this.seedPath = seedPath;
    this.backupDir = options.backupDir || path.join(path.dirname(filePath), 'backups');
    this.lastBackupAt = 0;
    this.data = { title: 'Our Family Tree', people: [] };
    this.load();
  }

  load() {
    let source = this.filePath;
    if (!fs.existsSync(source)) {
      if (this.seedPath && fs.existsSync(this.seedPath)) {
        source = this.seedPath;
      } else {
        this.save();
        return;
      }
    }
    const parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
    this.replaceAll(parsed, { persist: source !== this.filePath, backup: false });
  }

  save() {
    if (Date.now() - this.lastBackupAt > BACKUP_INTERVAL_MS) this.backup();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  // ---------- backups ----------

  /** Copies the saved tree into the backup folder. Returns the backup's name, or null if nothing is saved yet. */
  backup(reason = '') {
    if (!fs.existsSync(this.filePath)) return null;
    fs.mkdirSync(this.backupDir, { recursive: true });
    const base = `family-${timestamp()}${reason ? '-' + reason : ''}`;
    let name = `${base}.json`;
    for (let i = 2; fs.existsSync(path.join(this.backupDir, name)); i++) name = `${base}-${i}.json`;
    fs.copyFileSync(this.filePath, path.join(this.backupDir, name));
    this.lastBackupAt = Date.now();
    this.pruneBackups();
    return name;
  }

  pruneBackups() {
    const all = this.listBackups();
    for (const b of all.slice(BACKUPS_KEPT)) fs.rmSync(path.join(this.backupDir, b.name), { force: true });
  }

  listBackups() {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir)
      .filter((n) => BACKUP_NAME.test(n))
      .map((name) => {
        const stat = fs.statSync(path.join(this.backupDir, name));
        let people = null;
        try { people = JSON.parse(fs.readFileSync(path.join(this.backupDir, name), 'utf8')).people.length; } catch { /* unreadable */ }
        return { name, size: stat.size, savedAt: stat.mtime.toISOString(), people };
      })
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt) || b.name.localeCompare(a.name));
  }

  restoreBackup(name) {
    if (typeof name !== 'string' || !BACKUP_NAME.test(name)) throw new ValidationError('Unknown backup');
    const file = path.join(this.backupDir, name);
    if (!fs.existsSync(file)) throw new NotFoundError('That backup no longer exists');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return this.replaceAll(parsed, { reason: 'restore' });
  }

  // ---------- people ----------

  getAll() {
    return this.data;
  }

  get(id) {
    const person = this.data.people.find((p) => p.id === id);
    if (!person) throw new NotFoundError('Person not found');
    return person;
  }

  setTitle(title) {
    if (typeof title !== 'string' || !title.trim() || title.length > 200) {
      throw new ValidationError('title must be a non-empty string of at most 200 characters');
    }
    this.data.title = title.trim();
    this.save();
    return this.data.title;
  }

  create(input) {
    const person = sanitizePerson(input);
    person.id = crypto.randomUUID();
    this.checkRelations(person);
    this.data.people.push(person);
    this.syncSpouses(person);
    this.save();
    return person;
  }

  update(id, input) {
    const existing = this.get(id);
    const person = sanitizePerson(input, existing);
    this.checkRelations(person);
    Object.assign(existing, person);
    this.syncSpouses(existing);
    this.save();
    return existing;
  }

  remove(id) {
    this.get(id);
    this.data.people = this.data.people.filter((p) => p.id !== id);
    for (const p of this.data.people) {
      p.parentIds = p.parentIds.filter((pid) => pid !== id);
      p.spouseIds = p.spouseIds.filter((sid) => sid !== id);
      for (const e of p.events) if (e.spouseId === id) e.spouseId = '';
    }
    this.save();
  }

  /** Replaces the whole data set (used by import, restore and initial seeding). */
  replaceAll(input, { persist = true, backup = true, reason = 'import' } = {}) {
    if (!input || typeof input !== 'object' || !Array.isArray(input.people)) {
      throw new ValidationError('Imported data must be an object with a "people" array');
    }
    const seen = new Set();
    const people = input.people.map((raw) => {
      const person = sanitizePerson(raw);
      const id = raw && typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : crypto.randomUUID();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        throw new ValidationError(`Invalid person id "${id}": use letters, numbers, "-" or "_"`);
      }
      if (seen.has(id)) throw new ValidationError(`Duplicate person id: ${id}`);
      seen.add(id);
      person.id = id;
      return person;
    });
    // Drop dangling references rather than rejecting the whole import.
    for (const p of people) {
      p.parentIds = p.parentIds.filter((pid) => seen.has(pid) && pid !== p.id).slice(0, 2);
      p.spouseIds = p.spouseIds.filter((sid) => seen.has(sid) && sid !== p.id);
      for (const e of p.events) if (e.spouseId && (!seen.has(e.spouseId) || e.spouseId === p.id)) e.spouseId = '';
    }
    const byId = new Map(people.map((p) => [p.id, p]));
    for (const p of people) {
      for (const sid of p.spouseIds) {
        const spouse = byId.get(sid);
        if (!spouse.spouseIds.includes(p.id)) spouse.spouseIds.push(p.id);
      }
    }
    for (const p of people) {
      if (this.createsCycle(p.id, p.parentIds, byId)) {
        throw new ValidationError(`Person ${p.id} cannot be their own ancestor`);
      }
    }
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 200) : this.data.title;
    if (persist && backup) this.backup(reason);
    this.data = { title, people };
    if (persist) this.save();
    return this.data;
  }

  checkRelations(person) {
    const byId = new Map(this.data.people.map((p) => [p.id, p]));
    for (const field of ['parentIds', 'spouseIds']) {
      for (const rid of person[field]) {
        if (rid === person.id) throw new ValidationError('A person cannot be related to themselves');
        if (!byId.has(rid)) throw new ValidationError(`Unknown person id in ${field}: ${rid}`);
      }
    }
    for (const e of person.events) {
      if (e.spouseId && (e.spouseId === person.id || !byId.has(e.spouseId))) {
        throw new ValidationError(`The ${e.type.toLowerCase()} event names someone who isn't in the tree`);
      }
    }
    if (person.parentIds.length > 2) throw new ValidationError('A person can have at most two parents');
    if (person.id && this.createsCycle(person.id, person.parentIds, byId)) {
      throw new ValidationError('That parent choice would make this person their own ancestor');
    }
  }

  /** True if `id` would be reachable from its proposed parents' ancestry. */
  createsCycle(id, parentIds, byId) {
    const stack = [...parentIds];
    const visited = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (current === id) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const p = byId.get(current);
      if (p) stack.push(...p.parentIds);
    }
    return false;
  }

  /** Keeps spouse links symmetric: if A lists B, B lists A, and vice versa. */
  syncSpouses(person) {
    for (const other of this.data.people) {
      if (other.id === person.id) continue;
      const linked = person.spouseIds.includes(other.id);
      const hasBack = other.spouseIds.includes(person.id);
      if (linked && !hasBack) other.spouseIds.push(person.id);
      if (!linked && hasBack) other.spouseIds = other.spouseIds.filter((s) => s !== person.id);
    }
  }
}

module.exports = { FamilyStore, ValidationError, NotFoundError, sanitizePerson, EVENT_TYPES };
