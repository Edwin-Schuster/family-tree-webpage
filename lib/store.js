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
  bio: 5000,
};
const GENDERS = ['male', 'female', 'other', ''];

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
  return person;
}

class FamilyStore {
  constructor(filePath, seedPath) {
    this.filePath = filePath;
    this.seedPath = seedPath;
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
    this.replaceAll(parsed, { persist: source !== this.filePath });
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

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
    }
    this.save();
  }

  /** Replaces the whole data set (used by import and initial seeding). */
  replaceAll(input, { persist = true } = {}) {
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

module.exports = { FamilyStore, ValidationError, NotFoundError, sanitizePerson };
