'use strict';

/**
 * Builds an iCalendar (RFC 5545) feed of yearly family dates, for subscribing
 * from Apple Calendar, Google Calendar, Outlook and the like.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isoParts = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
  if (!m) return null;
  const y = +m[1], mo = +m[2], day = +m[3];
  return mo >= 1 && mo <= 12 && day >= 1 && day <= 31 ? { y, m: mo, d: day } : null;
};
const yearOf = (d) => { const m = /\d{4}/.exec(d || ''); return m ? +m[0] : null; };
const pad = (n) => String(n).padStart(2, '0');
const fullName = (p) => [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Unnamed';
const pretty = ({ y, m, d }) => `${d} ${MONTHS[m - 1]} ${y}`;
/** What the family calls someone: their quoted nickname, else their first given name. */
function shortName(p) {
  const nick = /"([^"]+)"/.exec(p.firstName || '');
  if (nick) return nick[1];
  return (p.firstName || '').split(/\s+/)[0] || fullName(p);
}

function isLiving(p, now) {
  if (p.deathDate) return false;
  const b = yearOf(p.birthDate);
  return !b || now.getUTCFullYear() - b < 105;
}

/** Escapes TEXT values (RFC 5545 §3.3.11). */
function text(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Folds a content line to 75 octets, continuing lines with a single space (RFC 5545 §3.1). */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; // don't split a UTF-8 character
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74;
  }
  return parts.join('\r\n ');
}

const dateValue = ({ y, m, d }) => `${y}${pad(m)}${pad(d)}`;
function nextDay({ y, m, d }) {
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const stamp = (now) => `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

/**
 * @param {{title: string, people: object[]}} data the family tree
 * @param {{remembrance?: boolean, host?: string, now?: Date}} options
 *   remembrance adds death anniversaries and anniversaries of couples no longer both living.
 */
function buildCalendar(data, { remembrance = false, host = 'family-tree', now = new Date() } = {}) {
  const byId = new Map(data.people.map((p) => [p.id, p]));
  const dtstamp = stamp(now);
  const events = [];

  const add = (uid, date, summary, description) => {
    // A 29 February date repeats on the last day of February in other years.
    const rule = date.m === 2 && date.d === 29 ? 'RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1' : 'RRULE:FREQ=YEARLY';
    events.push([
      'BEGIN:VEVENT',
      `UID:${uid}@${host}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${dateValue(date)}`,
      `DTEND;VALUE=DATE:${dateValue(nextDay(date))}`,
      rule,
      `SUMMARY:${text(summary)}`,
      `DESCRIPTION:${text(description)}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    ]);
  };

  for (const p of data.people) {
    const born = isoParts(p.birthDate);
    const living = isLiving(p, now);
    if (born && living) {
      add(`birthday-${p.id}`, born, `🎂 ${fullName(p)}’s birthday`,
        `Born ${pretty(born)}${p.birthPlace ? ` in ${p.birthPlace}` : ''}.`);
    }
    const died = isoParts(p.deathDate);
    if (remembrance && died) {
      add(`remembrance-${p.id}`, died, `🕯 Remembering ${fullName(p)}`,
        `${fullName(p)} died ${pretty(died)}${p.deathPlace ? ` in ${p.deathPlace}` : ''}${born ? ` (born ${born.y})` : ''}.`);
    }
  }

  // Weddings, once per couple even when both partners recorded the marriage.
  const seen = new Set();
  for (const p of data.people) {
    for (const e of p.events || []) {
      const date = e.type === 'Marriage' && isoParts(e.date);
      if (!date) continue;
      const spouse = byId.get(e.spouseId);
      const key = `${[p.id, e.spouseId || ''].sort().join('+')}-${dateValue(date)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const divorced = spouse && [p, spouse].some((x) => (x.events || []).some((d) => d.type === 'Divorce' && d.spouseId === (x === p ? spouse.id : p.id)));
      if (divorced) continue;
      const together = isLiving(p, now) && (!spouse || isLiving(spouse, now));
      if (!together && !remembrance) continue;
      const names = spouse ? `${shortName(p)} & ${shortName(spouse)}` : fullName(p);
      add(`anniversary-${key}`, date, `💍 ${names}’s anniversary`,
        `${spouse ? `${fullName(p)} and ${fullName(spouse)}` : fullName(p)} married ${pretty(date)}${e.place ? ` in ${e.place}` : ''}.`);
    }
  }

  const name = data.title || 'Family Tree';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Family Tree Webpage//Family calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${text(name)}`,
    `X-WR-CALDESC:${text(`Birthdays and anniversaries from ${name}`)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
    ...events.flat(),
    'END:VCALENDAR',
  ];
  return { body: lines.map(fold).join('\r\n') + '\r\n', count: events.length };
}

module.exports = { buildCalendar, fold, text };
