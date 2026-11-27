// In-memory stand-in for the US-3 database functions (job_* for the scheduler, assign_trips and
// clash_options for an adult's tap), with the same rules as ai-platform 20261127110000_prj02_trips.sql:
// a message is queued once per (trip, kind, person), claimed once, reminders only after a tap.
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

export function fakeTripsDb({ settings, adults, modes, country = 'SG', timeZone = 'Asia/Singapore' }) {
  const db = { trips: [], reminders: [], places: new Map(), settings: { ...settings }, adults, sent: [] };
  const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
  let clock = () => Date.now();
  db.setClock = (fn) => { clock = fn; };

  db.job = {
    families: async () => ['fam-1'],
    begin: async () => true,
    load: async () => ({ family_id: 'fam-1', country, settings: db.settings, calendar_id: 'cal', time_zone: timeZone,
      home: db.settings.home_lat != null ? { lat: db.settings.home_lat, lng: db.settings.home_lng } : null, adults, modes }),
    places: async () => new Map(db.places),
    savePlace: async (k, lat, lng, min, source, route = 'drive') => { db.places.set(`${route}|${k}`, { drive_min: min, source, lat, lng }); },
    upsertTrip: async (t) => {
      let x = db.trips.find((y) => y.event_id === t.event_id && y.event_start === iso(t.start));
      if (!x) { x = { id: uuid(), status: 'open', owner_person_id: null, owner_mode: null }; db.trips.push(x); }
      Object.assign(x, { event_id: t.event_id, event_start: iso(t.start), event_end: iso(t.end), title: t.title, location: t.location,
        drive_min: t.drive_min, drive_source: t.drive_source, drop_leave_at: iso(t.drop_leave), pick_leave_at: iso(t.pick_leave),
        drop_send_at: iso(t.drop_send), pick_send_at: iso(t.pick_send) });
      if (x.status === 'cancelled') x.status = 'open';
      for (const r of db.reminders) if (r.trip_id === x.id && r.status === 'due' && (r.kind === 'drop' || r.kind === 'pick')) r.send_at = r.kind === 'drop' ? x.drop_send_at : x.pick_send_at;
      return x.id;
    },
    cancelMissing: async (from, to, keep) => {
      let n = 0;
      for (const t of db.trips) {
        if (t.event_start >= iso(from) && t.event_start < iso(to) && t.status !== 'cancelled' && !keep.includes(t.id)) { t.status = 'cancelled'; n++; }
      }
      for (const r of db.reminders) if (r.status === 'due' && db.trips.find((t) => t.id === r.trip_id)?.status === 'cancelled') r.status = 'skipped';
      return n;
    },
    markScan: async (lat, lng) => { db.settings.last_scan_at = new Date(clock()).toISOString(); if (lat != null) Object.assign(db.settings, { home_lat: lat, home_lng: lng }); },
    trips: async (from, to) => db.trips.filter((t) => t.event_start >= iso(from) && t.event_start < iso(to)).sort((a, b) => a.event_start.localeCompare(b.event_start)),
    trip: async (id) => db.trips.find((t) => t.id === id) ?? null,
    queue: async (trip, kind, person, at, payload) => {
      if (!['plan', 'clash'].includes(kind)) throw new Error('the job queues only plan and clash messages');
      if (db.reminders.some((r) => r.trip_id === trip && r.kind === kind && r.person_id === person)) return false;
      db.reminders.push({ id: uuid(), trip_id: trip, kind, person_id: person, send_at: iso(at), status: 'due', payload: payload ?? {} });
      return true;
    },
    claimDue: async (limit) => {
      const now = clock();
      const due = db.reminders.filter((r) => r.status === 'due' && Date.parse(r.send_at) <= now)
        .sort((a, b) => a.send_at.localeCompare(b.send_at)).slice(0, limit);
      for (const r of due) { r.status = 'sent'; r.sent_at = new Date(now).toISOString(); }
      return due.map((r) => ({ ...r }));
    },
    markFailed: async (id) => { const r = db.reminders.find((x) => x.id === id); if (r) r.status = 'failed'; },
  };

  /** The chat bot's store for one adult (people, trips, assign_trips, clash_options). */
  db.botStore = (personId) => ({
    people: async () => adults.map((a) => ({ id: a.person_id, display_name: a.display_name })),
    trip: async (id) => db.trips.find((t) => t.id === id) ?? null,
    trips: async (from, to) => db.job.trips(from, to),
    clashOptions: async (id) => db.reminders.find((r) => r.id === id && r.kind === 'clash')?.payload ?? null,
    assignTrips: async (choices) => {
      for (const c of choices) {
        const t = db.trips.find((x) => x.id === c.trip);
        if (!t || t.status === 'cancelled') return { ok: false, reason: 'unknown' };
        if (c.mode === 'adult' && !adults.some((a) => a.person_id === c.person)) return { ok: false, reason: 'bad_choice' };
        const who = c.mode === 'adult' ? c.person : personId;
        Object.assign(t, { status: 'assigned', owner_mode: c.mode, owner_person_id: c.mode === 'adult' ? c.person : null, assigned_by: personId });
        db.reminders = db.reminders.filter((r) => !(r.trip_id === t.id && ['drop', 'pick'].includes(r.kind) && r.status === 'due'));
        for (const kind of ['drop', 'pick']) {
          const old = db.reminders.find((r) => r.trip_id === t.id && r.kind === kind && r.person_id === who);
          if (old) Object.assign(old, { send_at: kind === 'drop' ? t.drop_send_at : t.pick_send_at, status: 'due' });
          else db.reminders.push({ id: uuid(), trip_id: t.id, kind, person_id: who, send_at: kind === 'drop' ? t.drop_send_at : t.pick_send_at, status: 'due', payload: {} });
        }
        for (const r of db.reminders) if (r.trip_id === t.id && ['plan', 'clash'].includes(r.kind) && r.status === 'due') r.status = 'skipped';
      }
      db.settings.last_scan_at = null; // the next tick re-plans the family (travel time follows the way of travel)
      return { ok: true, assigned: choices.length };
    },
  });
  return db;
}
