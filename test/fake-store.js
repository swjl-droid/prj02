// In-memory stand-in for the app_prj02 functions (same answers as the SQL in
// ai-platform supabase/migrations/*_prj02_tenancy.sql), so the bot logic is tested without a database.
export function fakeDb() {
  const db = { families: [], people: [], contacts: [], consents: [], invites: [], refusals: 0, seq: 0 };
  const id = (p) => `${p}-${++db.seq}`;
  const norm = (c) => String(c ?? '').replace(/\s/g, '').toLowerCase();
  db.addFamily = (name, code, isAdmin = true, hoursLeft = 48) => {
    const f = { id: id('fam'), name };
    db.families.push(f);
    db.invites.push({ family_id: f.id, code: norm(code), is_admin: isAdmin, expires: Date.now() + hoursLeft * 3600e3, used: false });
    return f;
  };
  db.storeFor = () => {
    let cur = null;
    const ctxOf = (account) => {
      const c = db.contacts.find((x) => x.external_id === String(account).trim());
      if (!c) return null;
      const p = db.people.find((x) => x.id === c.person_id);
      const last = db.consents.filter((x) => x.person_id === p.id).at(-1);
      return { person_id: p.id, family_id: p.family_id, display_name: p.display_name, role: 'adult',
        is_admin: p.is_admin, notice_version: last?.version ?? null };
    };
    const check = (inv) => !inv ? 'unknown' : inv.used ? 'used' : inv.expires <= Date.now() ? 'expired' : null;
    return {
      async open(_ch, account) { cur = ctxOf(account); return cur; },
      async previewInvite(code) {
        const inv = db.invites.find((i) => i.code === norm(code));
        const bad = check(inv);
        return bad ? { ok: false, reason: bad } : { ok: true, family_name: db.families.find((f) => f.id === inv.family_id).name };
      },
      async acceptInvite(code, _ch, account, name, version) {
        const inv = db.invites.find((i) => i.code === norm(code));
        const bad = check(inv);
        if (bad) return { ok: false, reason: bad };
        if (db.contacts.some((c) => c.external_id === String(account).trim())) return { ok: false, reason: 'already_member' };
        const clean = String(name ?? '').replace(/\p{Cc}/gu, '').trim().slice(0, 80) || 'Adult';
        const p = { id: id('p'), family_id: inv.family_id, display_name: clean, is_admin: inv.is_admin };
        db.people.push(p);
        db.contacts.push({ person_id: p.id, family_id: p.family_id, external_id: String(account).trim() });
        db.consents.push({ person_id: p.id, version });
        inv.used = true;
        cur = ctxOf(account);
        return { ok: true, person_id: p.id, family_id: p.family_id };
      },
      async recordConsent(version) {
        if (!cur) throw new Error('no request context');
        db.consents.push({ person_id: cur.person_id, version });
        return true;
      },
      async createInvite(hours) {
        if (!cur) throw new Error('no request context');
        if (!cur.is_admin) return { ok: false, reason: 'not_admin' };
        const code = (id('c') + '0'.repeat(32)).replace(/[^0-9a-f]/g, '0').slice(0, 32);
        db.invites.push({ family_id: cur.family_id, code, is_admin: false, expires: Date.now() + hours * 3600e3, used: false });
        return { ok: true, code };
      },
      async forgetMe() {
        if (!cur) throw new Error('no request context');
        const pid = cur.person_id;
        db.people = db.people.filter((p) => p.id !== pid);
        db.contacts = db.contacts.filter((c) => c.person_id !== pid);
        db.consents = db.consents.filter((c) => c.person_id !== pid);
        return { 'app_prj02.people': 1 };
      },
      async noteRefusal() { db.refusals += 1; },
    };
  };
  return db;
}
