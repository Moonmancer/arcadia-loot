import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

// PKCE: Login-Code kommt als ?code=..., der Hash bleibt frei für das Routing
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: 'pkce' } });

const $app = document.getElementById('app');
let me = null;

// ---------- Hilfsfunktionen ----------

// DOM-Builder: Texte immer über textContent, nie innerHTML (Namen kommen von Nutzern)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const zenyFmt = new Intl.NumberFormat('de-DE');
const zeny = (n) => (n == null ? '–' : zenyFmt.format(n) + ' z');
const dateFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const date = (s) => dateFmt.format(new Date(s));

function icon(src) {
  return src ? h('img', { class: 'icon', src, alt: '', loading: 'lazy' }) : h('span', { class: 'icon empty' });
}

// Stückpreis für die Wertschätzung: Median der Angebote, sonst günstigstes Angebot
const unitPrice = (p) => (p ? p.sell_median ?? p.sell_min ?? null : null);

// Verkauf an NPC: halber NPC-Preis, mit Overcharge (Stufe 10) +24 % – Verkäufer hat den Skill
const npcSell = (npcPrice) => (npcPrice > 0 ? Math.floor(Math.floor(npcPrice / 2) * 124 / 100) : null);

let toastTimer;
function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 3000);
}

// Supabase-Ergebnis auspacken, Fehler als Exception
async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

// Button während einer Aktion sperren; Fehler als Toast
function action(fn) {
  return async (ev) => {
    const btn = ev?.currentTarget;
    if (btn) btn.disabled = true;
    try { await fn(ev); }
    catch (e) { toast(e.message, true); }
    finally { if (btn && btn.isConnected) btn.disabled = false; }
  };
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- Dialoge (statt confirm/prompt) ----------

// Eigener Dialog: Titel, Text, Liste offener Punkte, Felder (radio/check/text) und Knöpfe.
// Liefert { button, values } oder null bei Abbrechen/Escape/Klick daneben.
//   fields: [{ type: 'radio', name, value, options: [{ value, label, hint }] },
//            { type: 'check', name, label, value }, { type: 'text', name, value, placeholder }]
//   buttons: [{ label, value, primary, danger }]
function dialog({ title, text, items = [], fields = [], buttons }) {
  return new Promise((resolve) => {
    const values = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    let firstInput = null;
    const fieldEls = fields.map((f) => {
      if (f.type === 'radio') {
        return h('div', { class: 'stack dialog-field' }, f.options.map((o) => {
          const r = h('input', { type: 'radio', name: f.name, value: o.value });
          r.checked = o.value === f.value;
          r.addEventListener('change', () => { values[f.name] = o.value; });
          return h('label', { class: 'dialog-option' }, r,
            h('span', {}, o.label, o.hint ? h('span', { class: 'muted small' }, ' – ' + o.hint) : null));
        }));
      }
      if (f.type === 'check') {
        const c = h('input', { type: 'checkbox' });
        c.checked = !!f.value;
        c.addEventListener('change', () => { values[f.name] = c.checked; });
        return h('label', { class: 'dialog-option dialog-field' }, c, h('span', {}, f.label));
      }
      const inp = h('input', { type: 'text', value: f.value ?? '', placeholder: f.placeholder ?? '' });
      inp.addEventListener('input', () => { values[f.name] = inp.value; });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') close(buttons.find((b) => b.primary)?.value ?? buttons[0].value);
      });
      firstInput ??= inp;
      return h('div', { class: 'dialog-field row' }, inp);
    });

    const backdrop = h('div', { class: 'modal-backdrop' });
    const close = (button) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(button == null ? null : { button, values });
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const btnEls = buttons.map((b) => h('button', {
      class: [b.primary && 'primary', b.danger && 'danger'].filter(Boolean).join(' '),
      onclick: () => close(b.value),
    }, b.label));
    const modal = h('div', { class: 'modal panel', role: 'dialog', 'aria-modal': 'true' },
      h('h3', {}, title),
      text ? h('p', { class: 'muted' }, text) : null,
      items.length ? h('ul', { class: 'dialog-issues' }, items.map((i) => h('li', {}, i))) : null,
      fieldEls,
      h('div', { class: 'row dialog-buttons' },
        h('button', { onclick: () => close(null) }, 'Abbrechen'), btnEls),
    );
    backdrop.append(modal);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop);
    (firstInput ?? btnEls.find((b) => b.classList.contains('primary')) ?? btnEls[0])?.focus();
  });
}

async function confirmBox(title, text, ok = 'OK', danger = false) {
  return !!(await dialog({ title, text, buttons: [{ label: ok, value: 'ok', primary: !danger, danger }] }));
}

async function textBox(title, text, value = '', ok = 'Speichern', placeholder = '') {
  const r = await dialog({ title, text, fields: [{ type: 'text', name: 'v', value: String(value ?? ''), placeholder }],
    buttons: [{ label: ok, value: 'ok', primary: true }] });
  return r ? r.values.v : null;
}

// ---------- Kopfzeile / Login ----------

function renderUser() {
  const box = document.getElementById('user');
  box.replaceChildren();
  document.getElementById('nav').hidden = !me;
  if (!me) return;
  const meta = me.user_metadata || {};
  const name = meta.custom_claims?.global_name || meta.full_name || meta.name || 'Ich';
  box.append(
    ...[meta.avatar_url && h('img', { class: 'avatar', src: meta.avatar_url, alt: '' }),
      h('span', { class: 'name' }, name),
      h('button', { class: 'small', onclick: () => sb.auth.signOut() }, 'Abmelden')].filter(Boolean),
  );
}

function renderLogin() {
  $app.replaceChildren(
    h('div', { class: 'center stack' },
      h('h1', {}, 'Arcadia Loot'),
      h('p', { class: 'muted' }, 'Loot-Verteilung für Partys auf Arcadia Online – mit aktuellen Marktpreisen.'),
      h('button', {
        class: 'discord',
        onclick: action(async () => {
          await q(sb.auth.signInWithOAuth({
            provider: 'discord',
            options: { redirectTo: location.origin + location.pathname },
          }));
        }),
      }, 'Mit Discord anmelden'),
    ),
  );
}

// ---------- Routing ----------

const routes = [
  [/^#?\/?$/, viewParties],
  [/^#\/party\/(\d+)$/, viewParty],
  [/^#\/run\/(\d+)$/, viewRun],
  [/^#\/wunschliste$/, viewWishlist],
];

let renderSeq = 0;
async function route() {
  renderUser();
  if (!me) return renderLogin();
  const hash = location.hash || '#/';
  for (const a of document.querySelectorAll('#nav a')) {
    a.classList.toggle('active', a.getAttribute('href') === hash);
  }
  const match = routes.map(([re, fn]) => [hash.match(re), fn]).find(([m]) => m);
  if (!match) { location.hash = '#/'; return; }
  const seq = ++renderSeq;
  try {
    const view = await match[1](...match[0].slice(1));
    if (seq === renderSeq) {
      $app.replaceChildren(view);
      $app.classList.toggle('wide', match[1] === viewRun);   // Loot-Tabelle braucht Breite
    }
  } catch (e) {
    if (seq === renderSeq) $app.replaceChildren(h('p', { class: 'muted' }, 'Fehler: ' + e.message));
  }
}

const rerender = () => route();
window.addEventListener('hashchange', route);

// ---------- Abrechnung ----------

// Abrechnung eines Runs: Empfänger zahlen den Partypreis (pct % vom Stückpreis) in die Kasse, Rest ist gratis.
// Kasse + Verkaufserlöse werden gleichmäßig auf die Teilnehmer verteilt; Saldo = erhält − zahlt.
// Erwartet interests/participants mit profiles.display_name.
function settle({ status, pct, drops, interests, participants }) {
  const open = status === 'offen' || status === 'muell';
  // Stückpreis: Override des Admins, sonst Marktpreis (nur normale Items), sonst NPC-Verkaufspreis
  const unit = (d) => d.price_override ?? (d.is_plain ? unitPrice(d) : null) ?? npcSell(d.npc_price);
  const value = (d, amount = d.amount) => (unit(d) != null ? unit(d) * amount : null);
  const partyPrice = (d, amount = d.amount) => (unit(d) != null ? Math.round(unit(d) * amount * pct / 100) : null);

  const dropById = new Map(drops.map((d) => [d.id, d]));
  const withInterest = new Set(interests.map((i) => i.drop_id));
  // In der Phase „offen“ zählen nur direkte Zuweisungen, sonst alle zugeteilten Anteile
  const handouts = interests.filter((i) => i.share > 0 && !(open && dropById.get(i.drop_id)?.assigned_to == null));

  const people = new Map(participants.map((p) => [p.user_id, { name: p.profiles.display_name, items: [], pays: 0, paid_at: p.paid_at }]));
  let pot = 0;
  let missingPrice = 0;
  for (const i of handouts) {
    const d = dropById.get(i.drop_id);
    const p = people.get(i.user_id) ?? { name: i.profiles.display_name, items: [], pays: 0 };
    people.set(i.user_id, p);
    p.items.push(`${i.share}× ${d.name}` + (i.source === 'rest' ? ' (Rest)' : ''));
    if (i.source === 'rest') continue;
    const pp = partyPrice(d, i.share);
    if (pp == null) missingPrice++;
    p.pays += pp ?? 0;
    pot += pp ?? 0;
  }
  const sold = drops.filter((d) => !withInterest.has(d.id) && d.sold_price != null);
  const sales = sold.reduce((s, d) => s + d.sold_price, 0);
  const shareEach = participants.length ? Math.floor((pot + sales) / participants.length) : 0;
  const partIds = new Set(participants.map((p) => p.user_id));
  const rows = [...people.entries()]
    .map(([uid, p]) => ({ uid, ...p, gets: partIds.has(uid) ? shareEach : 0 }))
    .map((p) => ({ ...p, saldo: p.gets - p.pays }));
  return { unit, value, partyPrice, handouts, pot, sold, sales, shareEach, missingPrice, rows, partIds };
}

// ---------- Partys ----------

// Was beim angemeldeten Nutzer noch offen ist: Anteile abholen, Auszahlung (Saldo) in laufenden Runs
async function openTasks() {
  const [pickups, unpaid] = await Promise.all([
    q(sb.from('interests')
      .select('drop_id, share, source, drops!inner(name, run_id, runs!inner(id, title, status, parties(name)))')
      .eq('user_id', me.id).gt('share', 0).is('picked_up_at', null)
      .in('drops.runs.status', ['abholung', 'verkauf', 'auszahlung'])),
    q(sb.from('run_participants')
      .select('run_id, runs!inner(id, title, status, parties(name, party_price_pct))')
      .eq('user_id', me.id).is('paid_at', null).eq('runs.status', 'auszahlung')),
  ]);

  // Saldo je Run mit Auszahlung berechnen (gleiche Rechnung wie in der Run-Ansicht)
  const runIds = unpaid.map((u) => u.run_id);
  let payouts = [];
  if (runIds.length) {
    const [drops, interests, participants] = await Promise.all([
      q(sb.from('drop_overview').select('*').in('run_id', runIds)),
      q(sb.from('interests')
        .select('drop_id, user_id, share, source, profiles!interests_user_id_fkey(display_name), drops!inner(run_id)')
        .in('drops.run_id', runIds)),
      q(sb.from('run_participants').select('run_id, user_id, paid_at, profiles!run_participants_user_id_fkey(display_name)')
        .in('run_id', runIds)),
    ]);
    payouts = unpaid.map((u) => {
      const calc = settle({
        status: u.runs.status,
        pct: u.runs.parties.party_price_pct,
        drops: drops.filter((d) => d.run_id === u.run_id),
        interests: interests.filter((i) => i.drops.run_id === u.run_id),
        participants: participants.filter((p) => p.run_id === u.run_id),
      });
      return { run: u.runs, saldo: calc.rows.find((r) => r.uid === me.id)?.saldo ?? 0 };
    });
  }

  const byRun = new Map();
  for (const i of pickups) {
    const r = i.drops.runs;
    if (i.source === 'rest' && r.status !== 'auszahlung') continue;   // Rest wird mit der Auszahlung ausgehändigt
    if (!byRun.has(r.id)) byRun.set(r.id, { run: r, items: [] });
    byRun.get(r.id).items.push(`${zenyFmt.format(i.share)}× ${i.drops.name}` + (i.source === 'rest' ? ' (Rest)' : ''));
  }

  if (!byRun.size && !payouts.length) return null;
  const runLink = (r) => h('a', { href: `#/run/${r.id}` }, r.title, h('span', { class: 'muted small' }, ` · ${r.parties.name}`));
  return h('div', { class: 'cards', style: 'margin-bottom:8px' },
    byRun.size ? h('div', { class: 'panel', style: 'border-color:var(--accent)' },
      h('strong', {}, 'Abholen'),
      h('ul', { class: 'list' }, [...byRun.values()].map(({ run, items }) => h('li', { style: 'display:block' },
        runLink(run),
        h('div', { class: 'small muted' }, items.join(', ')),
      ))),
    ) : null,
    payouts.length ? h('div', { class: 'panel', style: 'border-color:var(--accent)' },
      h('strong', {}, 'Auszahlung'),
      h('ul', { class: 'list' }, payouts.map(({ run, saldo }) => h('li', { style: 'display:block' },
        runLink(run),
        h('div', { class: 'small', style: `color:var(${saldo < 0 ? '--bad' : '--good'})` },
          saldo < 0 ? `Du zahlst ${zeny(-saldo)} in die Kasse` : saldo > 0 ? `Du bekommst ${zeny(saldo)}` : 'Ausgeglichen – nichts zu zahlen'),
      ))),
    ) : null,
  );
}

async function viewParties() {
  const [parties, tasks] = await Promise.all([
    q(sb.from('parties')
      .select('id, name, created_at, party_members(count), runs(count)')
      .order('created_at', { ascending: false })),
    openTasks(),
  ]);

  const name = h('input', { type: 'text', placeholder: 'Name der neuen Party', maxlength: 60 });
  const create = action(async () => {
    if (!name.value.trim()) return name.focus();
    const p = await q(sb.from('parties').insert({ name: name.value.trim() }).select('id').single());
    location.hash = `#/party/${p.id}`;
  });
  name.addEventListener('keydown', (e) => e.key === 'Enter' && create(e));

  return h('div', {},
    tasks ? h('h1', {}, 'Offen bei dir') : null,
    tasks,
    h('h1', { style: tasks ? 'margin-top:24px' : '' }, 'Meine Partys'),
    parties.length
      ? h('div', { class: 'cards' }, parties.map((p) =>
          h('a', { class: 'panel card', href: `#/party/${p.id}` },
            h('strong', {}, p.name),
            h('div', { class: 'muted small' },
              `${p.party_members[0]?.count ?? 0} Mitglieder · ${p.runs[0]?.count ?? 0} Runs`),
          )))
      : h('p', { class: 'muted' }, 'Du bist noch in keiner Party. Lege eine an oder lass dich von einem Admin einer Party hinzufügen.'),
    h('h2', {}, 'Neue Party'),
    h('div', { class: 'row' }, name, h('button', { class: 'primary', onclick: create }, 'Anlegen')),
  );
}

const ROLES = { admin: 'Admin', verkaeufer: 'Verkäufer', teilnehmer: 'Teilnehmer' };
const ROLE_ORDER = { admin: 0, verkaeufer: 1, teilnehmer: 2 };
const byRoleAndName = (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]
  || a.profiles.display_name.localeCompare(b.profiles.display_name);

// Zeny-Eingabe: "2.300", "2300 z" usw. → Zahl; leer → null
function parseZeny(text) {
  const digits = String(text ?? '').replace(/[^\d]/g, '');
  return digits === '' ? null : Number(digits);
}

async function viewParty(id) {
  id = Number(id);
  const [party, members, runs, trash] = await Promise.all([
    q(sb.from('parties').select('id, name, created_by, party_price_pct').eq('id', id).maybeSingle()),
    q(sb.from('party_members').select('user_id, role, profiles(display_name, avatar_url)').eq('party_id', id)),
    q(sb.from('runs').select('id, title, status, created_at, drops(count)').eq('party_id', id)
      .order('created_at', { ascending: false })),
    q(sb.from('party_trash').select('item_id, items(name, icon, slots, npc_price)').eq('party_id', id)),
  ]);
  if (!party) return h('p', { class: 'muted' }, 'Party nicht gefunden oder kein Zugriff.');

  const isAdmin = members.some((m) => m.user_id === me.id && m.role === 'admin');
  members.sort(byRoleAndName);

  // Runs
  const title = h('input', { type: 'text', placeholder: 'z. B. Glast Heim, 23.10.', maxlength: 80 });
  const createRun = action(async () => {
    if (!title.value.trim()) return title.focus();
    const r = await q(sb.from('runs').insert({ party_id: id, title: title.value.trim() }).select('id').single());
    location.hash = `#/run/${r.id}`;
  });
  title.addEventListener('keydown', (e) => e.key === 'Enter' && createRun(e));

  const runList = runs.length
    ? h('ul', { class: 'list' }, runs.map((r) => h('li', {},
        h('a', { href: `#/run/${r.id}` }, r.title),
        statusBadge(r.status),
        h('span', { class: 'muted small', style: 'margin-left:auto' }, `${r.drops[0]?.count ?? 0} Drops · ${date(r.created_at)}`),
      )))
    : h('p', { class: 'muted' }, 'Noch keine Runs.');

  // Mitglieder
  const roleControl = (m) => {
    if (!isAdmin) return h('span', { class: 'badge' + (m.role === 'admin' ? ' warn' : '') }, ROLES[m.role]);
    const sel = h('select', {}, Object.entries(ROLES).map(([v, label]) => h('option', { value: v }, label)));
    sel.value = m.role;
    sel.addEventListener('change', async () => {
      try {
        await q(sb.from('party_members').update({ role: sel.value }).eq('party_id', id).eq('user_id', m.user_id));
        toast(`${m.profiles.display_name} ist jetzt ${ROLES[sel.value]}`);
      } catch (e) { toast(e.message, true); }
      rerender();
    });
    return sel;
  };

  const memberList = h('ul', { class: 'list' }, members.map((m) => h('li', {},
    m.profiles.avatar_url ? h('img', { class: 'avatar', src: m.profiles.avatar_url, alt: '' }) : null,
    h('span', {}, m.profiles.display_name),
    h('span', { class: 'row', style: 'margin-left:auto' },
      roleControl(m),
      m.user_id === me.id
        ? h('button', {
            class: 'small danger',
            onclick: action(async () => {
              if (!await confirmBox('Party verlassen', `Party „${party.name}“ wirklich verlassen?`, 'Verlassen', true)) return;
              await q(sb.from('party_members').delete().eq('party_id', id).eq('user_id', me.id));
              location.hash = '#/';
            }),
          }, 'Verlassen')
        : isAdmin
          ? h('button', {
              class: 'small danger',
              onclick: action(async () => {
                if (!await confirmBox('Mitglied entfernen', `${m.profiles.display_name} aus der Party entfernen?`, 'Entfernen', true)) return;
                await q(sb.from('party_members').delete().eq('party_id', id).eq('user_id', m.user_id));
                rerender();
              }),
            }, 'Entfernen')
          : null,
    ),
  )));

  let addMember = null;
  if (isAdmin) {
    const search = h('input', { type: 'search', placeholder: 'Spieler suchen (Discord-Name)' });
    const results = h('ul', { class: 'list' });
    const memberIds = new Set(members.map((m) => m.user_id));
    search.addEventListener('input', debounce(async () => {
      const term = search.value.trim();
      if (term.length < 2) return results.replaceChildren();
      try {
        const found = await q(sb.from('profiles').select('id, display_name, avatar_url')
          .ilike('display_name', `%${term}%`).limit(10));
        results.replaceChildren(...found.filter((p) => !memberIds.has(p.id)).map((p) => h('li', {},
          p.avatar_url ? h('img', { class: 'avatar', src: p.avatar_url, alt: '' }) : null,
          h('span', {}, p.display_name),
          h('button', {
            class: 'small', style: 'margin-left:auto',
            onclick: action(async () => {
              await q(sb.from('party_members').insert({ party_id: id, user_id: p.id }));
              toast(`${p.display_name} hinzugefügt`);
              rerender();
            }),
          }, 'Hinzufügen'),
        )));
        if (!results.children.length) results.append(h('li', { class: 'muted small' }, 'Niemand gefunden.'));
      } catch (e) { toast(e.message, true); }
    }, 300));
    addMember = h('div', { class: 'stack', style: 'margin-top:12px' },
      search, results,
      h('p', { class: 'muted small' }, 'Nur Spieler, die sich schon einmal angemeldet haben, sind auffindbar.'));
  }

  // Partypreis
  let priceSetting;
  if (isAdmin) {
    const pct = h('input', { type: 'number', min: 0, max: 100, value: party.party_price_pct, style: 'width:80px' });
    priceSetting = h('div', { class: 'row' },
      h('span', {}, 'Partypreis'), pct, h('span', {}, '% vom Marktpreis'),
      h('button', {
        class: 'small',
        onclick: action(async () => {
          await q(sb.from('parties').update({ party_price_pct: Number(pct.value) }).eq('id', id));
          toast('Partypreis gespeichert');
          rerender();
        }),
      }, 'Speichern'));
  } else {
    priceSetting = h('span', {}, `Partypreis: ${party.party_price_pct} % vom Marktpreis`);
  }

  const rename = isAdmin && h('button', {
    class: 'link small',
    onclick: action(async () => {
      const n = await textBox('Party umbenennen', null, party.name);
      if (!n || !n.trim()) return;
      await q(sb.from('parties').update({ name: n.trim() }).eq('id', id));
      rerender();
    }),
  }, 'umbenennen');

  const del = isAdmin && h('button', {
    class: 'small danger',
    onclick: action(async () => {
      if (!await confirmBox('Party löschen', `Party „${party.name}“ mit allen Runs endgültig löschen? Das lässt sich nicht rückgängig machen.`, 'Endgültig löschen', true)) return;
      await q(sb.from('parties').delete().eq('id', id));
      location.hash = '#/';
    }),
  }, 'Party löschen');

  // Müll-Liste: Items, die in der Phase „Müll verkaufen“ automatisch an NPC gehen
  trash.sort((a, b) => (a.items?.name ?? '').localeCompare(b.items?.name ?? ''));
  const trashIds = new Set(trash.map((t) => t.item_id));
  let trashAdd = null;
  if (isAdmin) {
    const search = h('input', { type: 'search', placeholder: 'Item zur Müll-Liste hinzufügen (Name oder ID)' });
    const results = h('ul', { class: 'list' });
    search.addEventListener('input', debounce(async () => {
      const term = search.value.trim();
      if (term.length < 2 && !/^\d+$/.test(term)) return results.replaceChildren();
      try {
        let query = sb.from('items').select('item_id, name, icon, slots, npc_price').limit(15);
        query = /^\d+$/.test(term) ? query.eq('item_id', Number(term)) : query.ilike('name', `%${term}%`).order('name');
        const found = await q(query);
        results.replaceChildren(...found.map((it) => h('li', {},
          icon(it.icon),
          h('span', {}, it.name + (it.slots ? ` [${it.slots}]` : '')),
          h('span', { class: 'muted small' }, `#${it.item_id} · NPC ${zeny(npcSell(it.npc_price))}`),
          trashIds.has(it.item_id)
            ? h('span', { class: 'badge', style: 'margin-left:auto' }, 'schon Müll')
            : h('button', {
                class: 'small', style: 'margin-left:auto',
                onclick: action(async () => {
                  await q(sb.from('party_trash').insert({ party_id: id, item_id: it.item_id }));
                  toast(`${it.name} ist jetzt Müll`);
                  rerender();
                }),
              }, 'Als Müll'),
        )));
        if (!found.length) results.append(h('li', { class: 'muted small' }, 'Nichts gefunden.'));
      } catch (e) { toast(e.message, true); }
    }, 300));
    trashAdd = h('div', { class: 'stack', style: 'margin-top:12px' }, search, results);
  }
  const trashList = trash.length
    ? h('ul', { class: 'list' }, trash.map((t) => h('li', {},
        icon(t.items?.icon),
        h('span', {}, (t.items?.name ?? `#${t.item_id}`) + (t.items?.slots ? ` [${t.items.slots}]` : '')),
        h('span', { class: 'muted small' }, `NPC ${zeny(npcSell(t.items?.npc_price))}`),
        isAdmin ? h('button', {
          class: 'small danger', style: 'margin-left:auto',
          onclick: action(async () => {
            await q(sb.from('party_trash').delete().eq('party_id', id).eq('item_id', t.item_id));
            rerender();
          }),
        }, 'Entfernen') : null,
      )))
    : h('p', { class: 'muted small' }, 'Noch keine Items als Müll markiert.');

  return h('div', {},
    h('p', { class: 'small' }, h('a', { href: '#/' }, '← Partys')),
    h('div', { class: 'row spread' }, h('h1', {}, party.name, rename), del),
    h('div', { class: 'muted small' }, priceSetting),
    h('h2', {}, 'Runs'),
    h('div', { class: 'row', style: 'margin-bottom:10px' }, title,
      h('button', { class: 'primary', onclick: createRun }, 'Neuer Run')),
    h('div', { class: 'panel' }, runList),
    h('h2', {}, `Mitglieder (${members.length})`),
    h('div', { class: 'panel' }, memberList, addMember),
    h('div', { class: 'row spread' },
      h('h2', {}, `Müll-Liste (${trash.length})`),
      isAdmin && trash.length ? h('button', {
        class: 'small danger',
        onclick: action(async () => {
          if (!await confirmBox('Müll-Liste leeren', `Alle ${trash.length} Einträge von der Müll-Liste der Party entfernen? ` +
            'Bereits verkaufter Müll in Runs bleibt verkauft.', 'Liste leeren', true)) return;
          await q(sb.from('party_trash').delete().eq('party_id', id));
          toast('Müll-Liste geleert');
          rerender();
        }),
      }, 'Müll-Liste leeren') : null),
    h('div', { class: 'panel' },
      h('p', { class: 'muted small', style: 'margin-top:0' },
        'Müll wird beim Würfeln automatisch an NPC verkauft – außer bei Wunschlisten-Konflikt, Interesse oder Zuweisung.'),
      trashList, trashAdd),
    h('p', { class: 'muted small' },
      'Admin: Mitglieder, Rollen, Partypreis, Müll-Liste, alle Runs, Preise überschreiben, Items zuweisen. ' +
      'Verkäufer: Verkaufserlöse erfassen. Teilnehmer: Interesse eintragen, eigene Runs anlegen.'),
  );
}

// ---------- Run ----------

const PHASES = ['offen', 'muell', 'abholung', 'verkauf', 'auszahlung', 'beendet'];
const PHASE_LABEL = {
  offen: 'Loot & Interessen', muell: 'Müll verkauft', abholung: 'Abholung', verkauf: 'Verkauf & Rest',
  auszahlung: 'Auszahlung', beendet: 'Beendet',
};
const statusBadge = (status) => h('span', {
  class: 'badge ' + (status === 'beendet' ? '' : status === 'offen' || status === 'muell' ? 'warn' : 'good'),
}, PHASE_LABEL[status]);

// Fortschrittsleiste: Erstellen → Loot → Müll → Würfeln → Abholung → Verkauf/Rest → Auszahlung → Beendet
function stepper(status, hasDrops) {
  const phase = PHASES.indexOf(status);
  const steps = [
    ['Erstellt', true],
    ['Loot befüllt', hasDrops],
    ['Müll verkauft', phase >= 2],
    ['Ausgewürfelt', phase >= 2],
    ['Abholung', phase > 2],
    ['Verkauf & Rest', phase > 3],
    ['Auszahlung', phase > 4],
    ['Beendet', phase >= 5],
  ];
  // hervorgehoben wird die aktuelle Phase („Ausgewürfelt“ ist nur der Übergang und nie aktuell)
  const current = { offen: hasDrops ? 1 : 0, muell: 2, abholung: 4, verkauf: 5, auszahlung: 6, beendet: 7 }[status];
  return h('ol', { class: 'stepper' }, steps.map(([label, done], i) =>
    h('li', { class: i === current ? 'current' : done ? 'done' : '' }, label)));
}

async function viewRun(id) {
  id = Number(id);
  const run = await q(sb.from('runs')
    .select('id, title, status, created_by, created_at, rolled_at, finished_at, party_id, parties(name, party_price_pct)')
    .eq('id', id).maybeSingle());
  if (!run) return h('p', { class: 'muted' }, 'Run nicht gefunden oder kein Zugriff.');

  // interests und run_participants haben je zwei FKs auf profiles → Beziehung explizit benennen
  const [drops, interests, members, participants, wishlist] = await Promise.all([
    q(sb.from('drop_overview').select('*').eq('run_id', id).order('pos')),
    q(sb.from('interests')
      .select('drop_id, user_id, roll, share, source, picked_up_at, profiles!interests_user_id_fkey(display_name), drops!inner(run_id)')
      .eq('drops.run_id', id)),
    q(sb.from('party_members').select('user_id, role, profiles(display_name)').eq('party_id', run.party_id)),
    q(sb.from('run_participants').select('user_id, paid_at, profiles!run_participants_user_id_fkey(display_name)').eq('run_id', id)),
    q(sb.from('wishlist').select('item_id')),
  ]);
  // Historie der letzten 10 Runs: was wurde mit übrigen Items gemacht → Vorbelegung in „Verkauf & Rest“
  const trends = run.status === 'verkauf' ? await q(sb.rpc('leftover_trends', { p_run: id })) : [];
  const trendBy = new Map(trends.map((t) => [t.item_id, t]));
  // Müll-Liste der Party und Wunschlisten-Konflikte (Müll wird in „Loot & Interessen“ markiert)
  // Müll-Liste wird immer gebraucht (Markieren in „offen“, danach Filter „Müll ausblenden“)
  const [trashRows, conflicts] = await Promise.all([
    q(sb.from('party_trash').select('item_id').eq('party_id', run.party_id)),
    run.status === 'offen' ? q(sb.rpc('wishlist_conflicts', { p_run: id })) : [],
  ]);
  const trash = new Set(trashRows.map((t) => t.item_id));
  // Nach dem Beenden: Items, die in den letzten 10 Runs immer an NPC gingen, als Müll vorschlagen (nur Admins)
  const isAdminHere = members.some((m) => m.user_id === me.id && m.role === 'admin');
  const suggestions = run.status === 'beendet' && isAdminHere ? await q(sb.rpc('trash_suggestions', { p_run: id })) : [];
  const conflictBy = new Map(conflicts.map((c) => [c.drop_id, c.names]));

  const status = run.status;
  const open = status === 'offen' || status === 'muell';          // vor dem Würfeln
  const trashPhase = status === 'offen';                          // Müll markieren
  const finished = status === 'beendet';
  const myRole = members.find((m) => m.user_id === me.id)?.role;
  const isAdmin = myRole === 'admin';
  const isSeller = isAdmin || myRole === 'verkaeufer';
  const canManage = run.created_by === me.id || isAdmin;
  const canAdvance = canManage || isSeller;
  const amParticipant = participants.some((p) => p.user_id === me.id);
  const pct = run.parties.party_price_pct;
  participants.sort((a, b) => a.profiles.display_name.localeCompare(b.profiles.display_name));
  const wished = new Set(wishlist.map((w) => w.item_id));
  const dropById = new Map(drops.map((d) => [d.id, d]));
  const byDrop = new Map();
  for (const i of interests) {
    if (!byDrop.has(i.drop_id)) byDrop.set(i.drop_id, []);
    byDrop.get(i.drop_id).push(i);
  }
  for (const list of byDrop.values()) {
    list.sort((a, b) => (b.roll ?? 0) - (a.roll ?? 0) || a.profiles.display_name.localeCompare(b.profiles.display_name));
  }

  const calc = settle({ status, pct, drops, interests, participants });
  const { unit, value, partyPrice, handouts } = calc;
  const total = drops.reduce((s, d) => s + (value(d) ?? 0), 0);
  const leftovers = drops.filter((d) => !byDrop.has(d.id));          // ohne Empfänger
  const unsold = leftovers.filter((d) => d.sold_price == null);
  const trashBlock = (d) => (conflictBy.has(d.id) ? 'wunschliste' : d.assigned_to != null ? 'zuweisung'
    : byDrop.has(d.id) ? 'interesse' : npcSell(d.npc_price) == null ? 'npc' : null);
  const trashToSell = trashPhase ? drops.filter((d) => trash.has(d.item_id) && d.sold_price == null && !trashBlock(d)) : [];

  const goTo = async (to) => {
    const n = await q(sb.rpc('set_run_status', { p_run: id, p_status: to }));
    rerender();
    return n;
  };
  const changeStatus = (to) => action(() => goTo(to));

  // Behebungen, die die Phasen-Dialoge anbieten
  const markPicked = async (list) => {
    for (const i of list) await q(sb.rpc('set_picked_up', { p_drop: i.drop_id, p_user: i.user_id, p_done: true }));
  };
  const sellNpc = async (list) => {
    for (const d of list) await q(sb.rpc('sell_to_npc', { p_drop: d.id }));
  };
  const splitRest = async (list) => {
    if (list.length) await q(sb.rpc('split_rest', { p_run: id, p_drops: list.map((d) => d.id) }));
  };
  const npcSum = (list) => list.reduce((s, d) => s + d.amount * npcSell(d.npc_price), 0);

  // ----- Kopf mit Phasen-Aktionen -----
  const phaseButtons = [];
  if (status === 'offen' && canAdvance && drops.length) {
    phaseButtons.push(h('button', {
      class: 'primary',
      onclick: action(async () => {
        const blocked = drops.filter((d) => trash.has(d.item_id) && d.sold_price == null && trashBlock(d));
        const r = await dialog({
          title: 'Weiter: Müll verkaufen',
          text: trashToSell.length
            ? `${trashToSell.length} Müll-Drop(s) werden für ${zeny(npcSum(trashToSell))} an NPC verkauft.`
            : 'Es ist kein Müll zu verkaufen.',
          items: [
            ...trashToSell.map((d) => `${zenyFmt.format(d.amount)}× ${d.name} → ${zeny(d.amount * npcSell(d.npc_price))}`),
            ...(blocked.length ? [`${blocked.length} Müll-Drop(s) bleiben wegen Konflikt (Wunschliste, Interesse, Zuweisung oder kein NPC-Preis)`] : []),
          ],
          buttons: [{ label: trashToSell.length ? 'Müll verkaufen & weiter' : 'Weiter', value: 'go', primary: true }],
        });
        if (!r) return;
        const n = await goTo('muell');
        toast(n ? `${n} Müll-Drop(s) an NPC verkauft` : 'Weiter – kein Müll verkauft');
      }),
    }, 'Weiter: Müll verkaufen →'));
  }
  if (status === 'muell' && canAdvance) {
    phaseButtons.push(h('button', {
      class: 'small',
      onclick: action(async () => {
        if (await confirmBox('Zurück zu „Loot & Interessen“',
          'Die Müll-Verkäufe dieses Runs werden rückgängig gemacht.', 'Zurück')) await goTo('offen');
      }),
    }, `← ${PHASE_LABEL.offen}`));
  }
  if (status === 'muell' && canManage) {
    phaseButtons.push(h('button', {
      class: 'primary',
      onclick: action(async () => {
        const withInterest = drops.filter((d) => (byDrop.get(d.id) || []).length).length;
        const free = drops.filter((d) => !byDrop.has(d.id) && d.sold_price == null).length;
        if (!await confirmBox('Auswürfeln',
          `${withInterest} Drop(s) mit Interessenten werden ausgewürfelt. ${free ? `${free} Drop(s) ohne Interessenten bleiben übrig ` +
          '(während der Abholung kann man sie nachmelden, danach verkaufen oder als Rest verteilen). ' : ''}` +
          'Danach können keine Interessen mehr geändert werden.', 'Auswürfeln')) return;
        await q(sb.rpc('roll_run', { p_run: id }));
        toast('Gewürfelt – Abholung beginnt');
        rerender();
      }),
    }, 'Auswürfeln'));
  }
  if (canAdvance && !open) {
    const i = PHASES.indexOf(status);
    if (i > 2) phaseButtons.push(h('button', { class: 'small', onclick: changeStatus(PHASES[i - 1]) }, `← ${PHASE_LABEL[PHASES[i - 1]]}`));
    // Rest wird erst mit der Auszahlung ausgehändigt und zählt vorher nicht als offene Abholung
    const openPickups = handouts.filter((x) => !x.picked_up_at && x.source !== 'rest');
    const openAll = handouts.filter((x) => !x.picked_up_at);
    const pickupField = (list) => (isSeller && list.length
      ? [{ type: 'check', name: 'pick', value: true, label: `${list.length} Anteil(e) jetzt als abgeholt markieren` }] : []);

    if (status === 'abholung') {
      phaseButtons.push(h('button', {
        class: 'primary',
        onclick: action(async () => {
          if (openPickups.length) {
            const r = await dialog({
              title: 'Weiter: Verkauf & Rest',
              text: 'Noch nicht alles ist abgeholt.',
              items: [`${openPickups.length} Anteil(e) nicht abgeholt`],
              fields: pickupField(openPickups),
              buttons: [{ label: isSeller ? 'Ausführen & weiter' : 'Trotzdem weiter', value: 'go', primary: true }],
            });
            if (!r) return;
            if (r.values.pick) await markPicked(openPickups);
          }
          await goTo('verkauf');
        }),
      }, 'Weiter: Verkauf & Rest →'));
    } else if (status === 'verkauf') {
      phaseButtons.push(h('button', {
        class: 'primary',
        onclick: action(async () => {
          if (unsold.length || openPickups.length) {
            // Vorauswahl aus der Tabelle: markierte Rest-Drops verteilen, übrige mit NPC-Preis an NPC
            const presetRest = unsold.filter((d) => restPick.has(d.id));
            const presetNpc = npcCandidates();
            const npcAble = unsold.filter((d) => npcSell(d.npc_price) != null);
            const noNpc = unsold.length - npcAble.length;
            const fields = [];
            if (unsold.length && isSeller) {
              const options = [];
              if (presetRest.length) {
                options.push({ value: 'preset', label: `Vorauswahl übernehmen: ${presetRest.length} als Rest verteilen, ${presetNpc.length} an NPC`,
                  hint: presetNpc.length ? `≈ ${zeny(npcSum(presetNpc))}` : '' });
              }
              if (npcAble.length) {
                options.push({ value: 'npc', label: `Alle übrigen an NPC verkaufen (${npcAble.length})`,
                  hint: `≈ ${zeny(npcSum(npcAble))}${noNpc ? `, ${noNpc} ohne NPC-Preis bleiben übrig` : ''}` });
              }
              options.push({ value: 'rest', label: `Alle übrigen als Rest zufällig verteilen (${unsold.length})`, hint: 'gratis, mit der Auszahlung ausgehändigt' });
              options.push({ value: 'none', label: 'Nichts tun', hint: 'übrige Drops sind nicht in der Abrechnung' });
              fields.push({ type: 'radio', name: 'leftover', value: options[0].value, options });
            }
            fields.push(...pickupField(openPickups));
            const r = await dialog({
              title: 'Weiter: Auszahlung',
              text: 'Es sind noch Entscheidungen offen.',
              items: [
                ...(unsold.length ? [`${unsold.length} Drop(s) weder verkauft noch als Rest verteilt`] : []),
                ...(openPickups.length ? [`${openPickups.length} Anteil(e) nicht abgeholt`] : []),
              ],
              fields,
              buttons: [{ label: isSeller ? 'Ausführen & weiter' : 'Trotzdem weiter', value: 'go', primary: true }],
            });
            if (!r) return;
            const choice = r.values.leftover;
            if (choice === 'preset') { await splitRest(presetRest); await sellNpc(presetNpc); }
            if (choice === 'npc') await sellNpc(npcAble);
            if (choice === 'rest') await splitRest(unsold);
            if (r.values.pick) await markPicked(openPickups);
          }
          await goTo('auszahlung');
        }),
      }, 'Weiter: Auszahlung →'));
    } else if (status === 'auszahlung') {
      phaseButtons.push(h('button', {
        class: 'primary',
        onclick: action(async () => {
          const unpaid = participants.filter((p) => !p.paid_at);
          const fields = [];
          if (isSeller && unpaid.length) {
            fields.push({ type: 'check', name: 'paid', value: true, label: `${unpaid.length} Teilnehmer jetzt als ausgezahlt markieren` });
          }
          if (isSeller && openAll.length) {
            fields.push({ type: 'check', name: 'pick', value: true, label: `${openAll.length} Anteil(e) jetzt als ausgehändigt markieren` });
          }
          const r = await dialog({
            title: 'Run beenden',
            text: unpaid.length || openAll.length ? 'Es ist noch etwas offen.' : 'Danach ist der Run nur noch lesbar.',
            items: [
              ...(unpaid.length ? [`Nicht ausgezahlt: ${unpaid.map((p) => p.profiles.display_name).join(', ')}`] : []),
              ...(openAll.length ? [`${openAll.length} Anteil(e) nicht ausgehändigt`] : []),
            ],
            fields,
            buttons: [{ label: fields.length ? 'Ausführen & beenden' : 'Run beenden', value: 'go', primary: true }],
          });
          if (!r) return;
          if (r.values.paid) {
            for (const p of unpaid) await q(sb.rpc('set_paid', { p_run: id, p_user: p.user_id, p_done: true }));
          }
          if (r.values.pick) await markPicked(openAll);
          await goTo('beendet');
        }),
      }, 'Run beenden'));
    }
  }

  // ----- Teilnehmer (Phase offen) -----
  let participantBox = null;
  if (open) {
    const partIds = new Set(participants.map((p) => p.user_id));
    const sorted = [...members].sort((a, b) => a.profiles.display_name.localeCompare(b.profiles.display_name));
    participantBox = h('div', { class: 'panel', style: 'margin:14px 0' },
      h('div', { class: 'row spread' },
        h('strong', {}, `Teilnehmer (${participants.length})`),
        h('span', { class: 'muted small' }, canManage ? 'Wer war beim Run dabei? Nur Teilnehmer bekommen Loot und Anteile.' : '')),
      h('div', { class: 'chips', style: 'margin-top:8px' }, sorted.map((m) => {
        const on = partIds.has(m.user_id);
        if (!canManage) return on ? h('span', { class: 'chip' + (m.user_id === me.id ? ' me' : '') }, m.profiles.display_name) : null;
        return h('button', {
          class: 'chip toggle' + (on ? ' win' : ' lose'),
          title: on ? 'Als Teilnehmer entfernen' : 'Als Teilnehmer hinzufügen',
          onclick: action(async () => {
            if (on) await q(sb.from('run_participants').delete().eq('run_id', id).eq('user_id', m.user_id));
            else await q(sb.from('run_participants').insert({ run_id: id, user_id: m.user_id }));
            rerender();
          }),
        }, (on ? '✓ ' : '+ ') + m.profiles.display_name);
      })),
      !amParticipant ? h('p', { class: 'small', style: 'color:var(--accent);margin:8px 0 0' },
        'Du bist kein Teilnehmer dieses Runs und kannst kein Interesse anmelden.') : null,
    );
  }

  // ----- Import -----
  let importBox = null;
  if (status === 'offen' && canManage) {
    const text = h('textarea', { placeholder: 'Guild-Storage-Liste hier einfügen (ID, Name, Amount, Attributes, Cards – tab-getrennt)' });
    importBox = h('details', { class: 'panel', open: drops.length === 0, style: 'margin:14px 0' },
      h('summary', {}, drops.length ? 'Weitere Liste einfügen' : 'Loot einfügen'),
      h('div', { class: 'stack', style: 'margin-top:10px' },
        text,
        h('button', {
          class: 'primary',
          onclick: action(async () => {
            if (!text.value.trim()) return text.focus();
            const n = await q(sb.rpc('import_drops', { p_run: id, p_text: text.value }));
            toast(n ? `${n} Drops importiert` : 'Keine Zeilen erkannt – Format prüfen', !n);
            if (n) rerender();
          }),
        }, 'Importieren'),
      ));
  }

  // ----- Ausgabe / Abholung -----
  const pickToggle = (i) => {
    const restLater = i.source === 'rest' && status !== 'auszahlung';
    const allowed = !finished && !restLater && (i.user_id === me.id || isSeller) && status !== 'offen';
    const box = h('input', { type: 'checkbox', disabled: !allowed, title: restLater ? 'Rest wird mit der Auszahlung ausgehändigt' : '' });
    box.checked = !!i.picked_up_at;
    box.addEventListener('change', async () => {
      try {
        await q(sb.rpc('set_picked_up', { p_drop: i.drop_id, p_user: i.user_id, p_done: box.checked }));
      } catch (e) { toast(e.message, true); }
      rerender();
    });
    return box;
  };

  let pickupBox = null;
  // In der Auszahlung werden nur noch die Rest-Items ausgehändigt
  const toHandOut = status === 'auszahlung' ? handouts.filter((i) => i.source === 'rest') : handouts;
  if (!open && toHandOut.length) {
    const byUser = new Map();
    for (const i of toHandOut) {
      if (!byUser.has(i.user_id)) byUser.set(i.user_id, { name: i.profiles.display_name, list: [] });
      byUser.get(i.user_id).list.push(i);
    }
    const done = toHandOut.filter((i) => i.picked_up_at).length;
    pickupBox = h('div', {},
      h('h2', {}, `${status === 'auszahlung' ? 'Ausgabe Rest' : 'Ausgabe'} (${done}/${toHandOut.length} abgeholt)`),
      h('div', { class: 'cards' }, [...byUser.entries()]
        .sort((a, b) => (a[0] === me.id ? -1 : b[0] === me.id ? 1 : a[1].name.localeCompare(b[1].name)))
        .map(([uid, u]) => {
          const all = u.list.every((i) => i.picked_up_at);
          // „Alles abgeholt“: alle offenen Anteile, die jetzt abgehakt werden dürfen (Rest erst in der Auszahlung)
          const pickable = finished || !(uid === me.id || isSeller) ? []
            : u.list.filter((i) => !i.picked_up_at && !(i.source === 'rest' && status !== 'auszahlung'));
          const allBtn = pickable.length ? h('button', {
            class: 'small',
            onclick: action(async () => {
              for (const i of pickable) await q(sb.rpc('set_picked_up', { p_drop: i.drop_id, p_user: uid, p_done: true }));
              toast(`${u.name}: ${pickable.length} Anteil(e) als abgeholt markiert`);
              rerender();
            }),
          }, 'Alles abgeholt') : null;
          return h('div', { class: 'panel', style: uid === me.id ? 'border-color:var(--accent)' : '' },
            h('div', { class: 'row spread' }, h('strong', {}, u.name),
              all ? h('span', { class: 'badge good' }, 'alles abgeholt')
                : h('span', { class: 'row' }, allBtn, h('span', { class: 'badge warn' }, 'offen'))),
            h('ul', { class: 'list' }, u.list.map((i) => h('li', { class: 'small' },
              h('label', { class: 'row', style: 'flex-wrap:nowrap' }, pickToggle(i),
                `${zenyFmt.format(i.share)}× ${dropById.get(i.drop_id).name}`,
                i.source === 'rest' ? h('span', { class: 'badge' }, status === 'verkauf' ? 'Rest · bei Auszahlung' : 'Rest') : null),
            ))),
          );
        })),
    );
  }

  // ----- Aktionen in der Tabelle -----
  const toggleInterest = (d, mine) => action(async () => {
    if (mine) await q(sb.from('interests').delete().eq('drop_id', d.id).eq('user_id', me.id));
    else await q(sb.from('interests').insert({ drop_id: d.id }));
    rerender();
  });

  const toggleWish = (d) => action(async () => {
    const base = d.name.replace(/\s*\[\d+\]$/, '');
    if (wished.has(d.item_id)) {
      await q(sb.from('wishlist').delete().eq('item_id', d.item_id).eq('user_id', me.id));
      toast(`${base} von der Wunschliste entfernt`);
    } else {
      await q(sb.from('wishlist').insert({ item_id: d.item_id }));
      toast(open ? `${base} auf die Wunschliste gesetzt – Interesse automatisch eingetragen` : `${base} auf die Wunschliste gesetzt`);
    }
    rerender();
  });

  const editPrice = (d) => action(async () => {
    const input = await textBox(`Stückpreis für ${d.name}`, 'Zeny pro Stück. Leer lassen, um wieder den Marktpreis zu verwenden.',
      d.price_override ?? unitPrice(d) ?? '', 'Speichern', 'Marktpreis');
    if (input === null) return;
    await q(sb.rpc('set_price', { p_drop: d.id, p_price: parseZeny(input) }));
    rerender();
  });

  const assignSelect = (d) => {
    const sel = h('select', { title: 'Direkt zuweisen (wird nicht gewürfelt)' },
      h('option', { value: '' }, open ? 'würfeln' : '– niemand –'),
      participants.map((p) => h('option', { value: p.user_id }, '→ ' + p.profiles.display_name)));
    sel.value = d.assigned_to ?? '';
    sel.addEventListener('change', async () => {
      try {
        await q(sb.rpc('assign_drop', { p_drop: d.id, p_user: sel.value || null }));
      } catch (e) { toast(e.message, true); }
      rerender();
    });
    return sel;
  };

  const saleControl = (d) => {
    const inp = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Erlös', style: 'width:110px;flex:none',
      value: d.sold_price != null ? zenyFmt.format(d.sold_price) : '' });
    const save = action(async () => {
      await q(sb.rpc('set_sale', { p_drop: d.id, p_price: parseZeny(inp.value) }));
      toast(inp.value.trim() ? 'Verkauf gespeichert' : 'Verkauf entfernt');
      rerender();
    });
    inp.addEventListener('keydown', (e) => e.key === 'Enter' && save(e));
    return h('div', { class: 'row', style: 'flex-wrap:nowrap' }, inp, h('button', { class: 'small', onclick: save }, '✓'));
  };

  // Rest-Auswahl (Phase Verkauf)
  const restPick = new Set();
  const restMode = status === 'verkauf' && isSeller;
  const restButton = h('button', {
    class: 'primary', disabled: true,
    onclick: action(async () => {
      const n = restPick.size;
      if (!await confirmBox('Rest verteilen', `${n} Drop(s) gratis und zufällig an die ${participants.length} Teilnehmer verteilen? ` +
        'Jeder Eintrag geht komplett an eine Person.', 'Verteilen')) return;
      await q(sb.rpc('split_rest', { p_run: id, p_drops: [...restPick] }));
      toast(`${n} Drop(s) aufgeteilt`);
      rerender();
    }),
  }, 'Ausgewählte zufällig verteilen');
  const restBoxes = [];
  // „Alle an NPC“ verkauft alle übrigen Drops mit NPC-Preis, außer den als Rest markierten
  const npcCandidates = () => unsold.filter((d) => npcSell(d.npc_price) != null && !restPick.has(d.id));
  const npcAllButton = h('button', {
    class: 'small',
    title: 'Alle übrigen Drops mit NPC-Preis an NPC verkaufen – als Rest markierte bleiben übrig',
    onclick: action(async () => {
      const list = npcCandidates();
      if (!list.length) return;
      const sum = list.reduce((s, d) => s + d.amount * npcSell(d.npc_price), 0);
      if (!await confirmBox('An NPC verkaufen', `${list.length} übrige Drop(s) für zusammen ${zeny(sum)} an NPC verkaufen? ` +
        'Als Rest markierte bleiben übrig.', 'Verkaufen')) return;
      for (const d of list) await q(sb.rpc('sell_to_npc', { p_drop: d.id }));
      toast(`${list.length} Drop(s) an NPC verkauft`);
      rerender();
    }),
  });
  const updateRestButton = () => {
    restButton.disabled = restPick.size === 0;
    restButton.textContent = restPick.size ? `${restPick.size} zufällig verteilen` : 'Ausgewählte zufällig verteilen';
    const n = npcCandidates().length;
    npcAllButton.disabled = n === 0;
    npcAllButton.textContent = `Übrige an NPC (${n})`;
  };

  // Vorschlag aus der Historie: häufigstes Ergebnis, bei Gleichstand keiner
  const TREND_LABEL = { rest: 'Rest', npc: 'NPC', sold: 'Spieler' };
  const suggestion = (d) => {
    const t = trendBy.get(d.item_id);
    if (!t) return null;
    const counts = [['rest', t.rest_count], ['npc', t.npc_count], ['sold', t.sold_count]].sort((a, b) => b[1] - a[1]);
    if (counts[0][1] === 0 || counts[0][1] === counts[1][1]) return null;
    return { kind: counts[0][0], n: counts[0][1], total: t.rest_count + t.npc_count + t.sold_count };
  };

  // Filter
  const filter = h('input', { type: 'search', placeholder: 'Filtern …' });
  const withoutRecipients = h('input', { type: 'checkbox' });
  const onlyTrash = h('input', { type: 'checkbox' });
  // Ab „Müll verkauft“: an NPC verkauften Müll standardmäßig ausblenden
  const hideTrash = h('input', { type: 'checkbox' });
  hideTrash.checked = status !== 'offen';
  const isSoldTrash = (d) => trash.has(d.item_id) && d.sold_to_npc;
  const soldTrashCount = drops.filter(isSoldTrash).length;

  const rows = drops.map((d) => {
    const list = byDrop.get(d.id) || [];
    const mine = list.some((i) => i.user_id === me.id);
    const assigned = d.assigned_to != null;
    const isRest = list.some((i) => i.source === 'rest');
    const chips = h('div', { class: 'chips' }, list.filter((i) => !isRest || i.share > 0).map((i) => {
      const settled = !open || assigned;
      const cls = ['chip', i.user_id === me.id && 'me', settled && (i.share > 0 ? 'win' : 'lose')].filter(Boolean).join(' ');
      let label = i.profiles.display_name;
      if (i.source === 'zuweisung') label += ` → ${i.share}× (zugewiesen)`;
      else if (i.source === 'nachmeldung') label += ` → ${i.share}× (nachgemeldet)`;
      else if (i.source === 'rest') label += ` ${i.share}×`;
      else if (!open) label += ` ${i.roll}` + (d.amount > 1 ? ` → ${i.share}×` : '');
      else if (i.source === 'wunschliste') label += ' ★';
      if (i.picked_up_at) label += ' ✓';
      return h('span', { class: cls, title: i.picked_up_at ? 'abgeholt' : i.source === 'wunschliste' ? 'über Wunschliste' : '' }, label);
    }));
    if (isRest) chips.prepend(h('span', { class: 'badge', style: 'margin:0 4px 0 0' }, 'Rest'));
    if (!list.length) {
      chips.append(d.sold_price != null
        ? h('span', { class: 'chip win' }, `${d.sold_to_npc ? 'an NPC verkauft' : 'verkauft'} ${zeny(d.sold_price)}`)
        : open ? h('span', { class: 'muted small' }, '–') : h('span', { class: 'muted small' }, 'übrig'));
    }

    const priceCell = h('td', { class: 'num hide-sm' },
      d.price_override != null
        ? h('span', { title: 'Vom Admin festgelegt' }, h('span', { class: 'badge warn badge-before' }, 'fest'), zeny(d.price_override))
        : d.is_plain && unitPrice(d) != null ? zeny(unitPrice(d))
        : npcSell(d.npc_price) != null
          ? h('span', { title: d.is_plain ? 'Kein Marktpreis – NPC-Verkaufspreis als Ersatz' : 'Marktpreis gilt nur für normale Items – NPC-Verkaufspreis als Ersatz' },
              h('span', { class: 'badge badge-before' }, 'NPC'), zeny(npcSell(d.npc_price)))
          : '–',
      isAdmin && ['offen', 'muell', 'abholung', 'verkauf'].includes(status)
        ? h('button', { class: 'link small', title: 'Preis überschreiben', onclick: editPrice(d) }, '✎') : null,
      isAdmin ? h('a', {
        class: 'small', style: 'padding:0 4px;text-decoration:none',
        href: `https://arcadia-market.de/sells/item_id/${encodeURIComponent(d.item_id)}`,
        target: '_blank', rel: 'noopener noreferrer',
        title: 'Verkaufsangebote auf arcadia-market.de',
      }, '📈') : null);

    const actions = [];
    if (open && !assigned && d.sold_price == null && amParticipant) {
      actions.push(h('button', { class: 'small' + (mine ? ' on' : ''), onclick: toggleInterest(d, mine) }, mine ? 'Will ich ✓' : 'Will ich'));
    }
    // Nachmelden während der Abholung: wer zuerst kommt, übernimmt den Drop zum Partypreis
    if (status === 'abholung' && myRole && !list.length && d.sold_price == null && !assigned) {
      actions.push(h('button', {
        class: 'small',
        title: 'Übrigen Drop übernehmen – wer zuerst kommt',
        onclick: action(async () => {
          const pp = partyPrice(d);
          if (!await confirmBox('Item übernehmen', `${d.name} (${zenyFmt.format(d.amount)}×) übernehmen?` +
            (pp != null ? ` Du zahlst den Partypreis von ${zeny(pp)} in die Kasse.` : ''), 'Übernehmen')) return;
          await q(sb.rpc('claim_drop', { p_drop: d.id }));
          toast(`${d.name} übernommen`);
          rerender();
        }),
      }, 'Nehme ich'));
    }
    if (status === 'abholung' && list.some((i) => i.user_id === me.id && i.source === 'nachmeldung' && !i.picked_up_at)) {
      actions.push(h('button', {
        class: 'small',
        onclick: action(async () => {
          await q(sb.rpc('unclaim_drop', { p_drop: d.id }));
          rerender();
        }),
      }, 'Zurückgeben'));
    }
    if (['abholung', 'verkauf'].includes(status) && !list.length && isSeller) actions.push(saleControl(d));
    if (status === 'verkauf' && !list.length && isSeller && !d.sold_to_npc && npcSell(d.npc_price) != null) {
      actions.push(h('button', {
        class: 'small',
        title: `An NPC verkaufen: ${zenyFmt.format(d.amount)} × ${zeny(npcSell(d.npc_price))} (½ NPC-Preis + 24 % Overcharge)`,
        onclick: action(async () => {
          const price = await q(sb.rpc('sell_to_npc', { p_drop: d.id }));
          toast(`${d.name} an NPC verkauft: ${zeny(price)}`);
          rerender();
        }),
      }, 'NPC'));
    }
    if (restMode && !list.length && d.sold_price == null) {
      const box = h('input', { type: 'checkbox', title: 'Für zufällige Aufteilung auswählen' });
      if (suggestion(d)?.kind === 'rest') { box.checked = true; restPick.add(d.id); }
      box.addEventListener('change', () => { box.checked ? restPick.add(d.id) : restPick.delete(d.id); updateRestButton(); });
      restBoxes.push([box, d.id]);
      actions.push(h('label', { class: 'row small muted', style: 'flex-wrap:nowrap' }, box, 'Rest'));
    }
    if (restMode && isRest) {
      actions.push(h('button', {
        class: 'small',
        onclick: action(async () => {
          await q(sb.rpc('undo_rest', { p_drop: d.id }));
          rerender();
        }),
      }, 'Aufteilung zurück'));
    }
    if (isAdmin && ['offen', 'muell', 'abholung', 'verkauf'].includes(status) && !isRest && !d.sold_to_npc) {
      actions.push(assignSelect(d));
    }
    if (trashPhase && isAdmin && d.item_type != null) {
      const isTrash = trash.has(d.item_id);
      actions.push(h('button', {
        class: 'small' + (isTrash ? ' on' : ''),
        title: isTrash ? 'Von der Müll-Liste der Party nehmen' : 'Auf die Müll-Liste der Party setzen',
        onclick: action(async () => {
          if (isTrash) await q(sb.from('party_trash').delete().eq('party_id', run.party_id).eq('item_id', d.item_id));
          else await q(sb.from('party_trash').insert({ party_id: run.party_id, item_id: d.item_id }));
          rerender();
        }),
      }, isTrash ? 'Müll ✓' : 'Müll'));
    }
    if (open && canManage) {
      actions.push(h('button', {
        class: 'link small', title: 'Drop löschen',
        onclick: action(async () => {
          await q(sb.from('drops').delete().eq('id', d.id));
          rerender();
        }),
      }, '✕'));
    }

    const tr = h('tr', {},
      h('td', { class: 'hide-sm' }, icon(d.icon)),
      h('td', {},
        d.name,
        !d.is_plain ? h('span', { class: 'badge warn', title: [d.attributes, d.cards].filter(Boolean).join(' · ') },
          'Attr./Karten') : null,
        trashPhase && trash.has(d.item_id) ? (() => {
          const block = d.sold_price == null ? trashBlock(d) : null;
          if (!block) return h('span', { class: 'badge', title: 'Wird beim Würfeln an NPC verkauft' }, 'Müll → NPC');
          const text = {
            wunschliste: `⚠ Wunschliste: ${(conflictBy.get(d.id) || []).join(', ')}`,
            interesse: '⚠ Interesse eingetragen',
            zuweisung: '⚠ zugewiesen',
            npc: '⚠ kein NPC-Preis',
          }[block];
          return h('span', { class: 'badge warn', title: 'Müll – wird beim Würfeln nicht verkauft' }, `Müll · ${text}`);
        })() : null,
        (() => {
          const sug = restMode && !list.length && d.sold_price == null ? suggestion(d) : null;
          return sug ? h('span', {
            class: 'badge' + (sug.kind === 'rest' ? ' good' : ''),
            title: `In den letzten Runs übrig: ${sug.total}×, davon ${sug.n}× ${TREND_LABEL[sug.kind]}`,
          }, `Trend: ${TREND_LABEL[sug.kind]} ${sug.n}/${sug.total}`) : null;
        })(),
        // nur Items, die in der Item-Datenbank stehen (Wunschliste hat FK auf items)
        d.item_type != null ? h('div', {},
          h('button', {
            class: 'wish' + (wished.has(d.item_id) ? ' on' : ''),
            title: wished.has(d.item_id) ? 'Von deiner Wunschliste entfernen' : 'Auf deine Wunschliste setzen',
            onclick: toggleWish(d),
          }, wished.has(d.item_id) ? '★ Wunschliste' : '☆ Wunschliste'),
        ) : null,
      ),
      h('td', { class: 'num' }, zenyFmt.format(d.amount)),
      priceCell,
      h('td', { class: 'num hide-sm muted' }, zeny(npcSell(d.npc_price))),
      h('td', { class: 'num hide-sm' }, zeny(value(d))),
      h('td', { class: 'num' }, isRest ? h('span', { class: 'muted', title: 'Rest ist gratis' }, 'gratis') : zeny(partyPrice(d))),
      h('td', {}, chips),
      h('td', {}, actions.length ? h('div', { class: 'row', style: 'flex-wrap:nowrap' }, actions) : null),
    );
    tr.dataset.search = d.name.toLowerCase();
    tr.dataset.interest = list.length ? '1' : '';
    tr.dataset.trash = trash.has(d.item_id) ? '1' : '';
    tr.dataset.soldtrash = isSoldTrash(d) ? '1' : '';
    return tr;
  });

  const applyFilter = () => {
    const term = filter.value.trim().toLowerCase();
    for (const tr of rows) {
      tr.hidden = (term && !tr.dataset.search.includes(term)) || (withoutRecipients.checked && tr.dataset.interest)
        || (onlyTrash.checked && !tr.dataset.trash) || (hideTrash.checked && tr.dataset.soldtrash);
    }
    // Zebrastreifen über die sichtbaren Zeilen, damit sie auch mit Filter abwechseln
    let visible = 0;
    for (const tr of rows) if (!tr.hidden) tr.classList.toggle('alt', visible++ % 2 === 1);
  };
  filter.addEventListener('input', applyFilter);
  withoutRecipients.addEventListener('change', applyFilter);
  onlyTrash.addEventListener('change', applyFilter);
  hideTrash.addEventListener('change', applyFilter);
  applyFilter();

  updateRestButton();
  const restBar = restMode && unsold.length ? h('div', { class: 'panel row spread', style: 'margin:10px 0' },
    h('span', { class: 'small' },
      `${unsold.length} Drop(s) übrig: Erlös eintragen, an NPC verkaufen oder als „Rest“ markieren und gratis zufällig verteilen ` +
      '(jeder Eintrag komplett an eine Person, reihum gleichmäßig). Vorauswahl „Rest“ nach Trend der letzten 10 Runs.'),
    h('div', { class: 'row' },
      unsold.some((d) => npcSell(d.npc_price) != null) ? npcAllButton : null,
      h('button', {
        class: 'small',
        onclick: () => { for (const [box, did] of restBoxes) { box.checked = true; restPick.add(did); } updateRestButton(); },
      }, 'Alle übrigen auswählen'),
      restButton),
  ) : null;

  const table = drops.length
    ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { class: 'hide-sm' }), h('th', {}, 'Item'), h('th', { class: 'num' }, 'Menge'),
          h('th', { class: 'num hide-sm' }, 'Stückpreis'),
          h('th', { class: 'num hide-sm', title: 'Verkauf an NPC pro Stück (½ NPC-Preis + 24 % Overcharge)' }, 'NPC'),
          h('th', { class: 'num hide-sm' }, 'Gesamt'),
          h('th', { class: 'num', title: `${pct} % vom Gesamtpreis` }, `Partypreis ${pct} %`),
          h('th', {}, open ? 'Interessenten' : 'Ergebnis'), h('th', {}),
        )),
        h('tbody', {}, rows),
      ))
    : h('p', { class: 'muted' }, 'Noch kein Loot.');

  // ----- Abrechnung: Empfänger zahlen den Partypreis, Kasse + Verkäufe gehen an die Teilnehmer -----
  let summary = null;
  if (drops.length && handouts.length) {
    const { pot, sold, sales, shareEach, missingPrice, partIds } = calc;
    const rowsSum = [...calc.rows].sort((a, b) => a.saldo - b.saldo);
    const showPaid = ['auszahlung', 'beendet'].includes(status);

    const paidToggle = (p) => {
      if (!partIds.has(p.uid)) return null;
      const box = h('input', { type: 'checkbox', disabled: !(isSeller && status === 'auszahlung') });
      box.checked = !!p.paid_at;
      box.addEventListener('change', async () => {
        try {
          await q(sb.rpc('set_paid', { p_run: id, p_user: p.uid, p_done: box.checked }));
        } catch (e) { toast(e.message, true); }
        rerender();
      });
      return box;
    };

    summary = h('div', {},
      h('h2', {}, open ? 'Abrechnung (bisher zugewiesen)' : 'Abrechnung'),
      h('div', { class: 'cards', style: 'margin-bottom:10px' },
        h('div', { class: 'panel' }, h('div', { class: 'muted small' }, 'Kasse aus Partypreisen'), h('strong', {}, zeny(pot))),
        h('div', { class: 'panel' }, h('div', { class: 'muted small' }, `Verkäufe (${sold.length})`), h('strong', {}, zeny(sales))),
        h('div', { class: 'panel' }, h('div', { class: 'muted small' }, `Anteil pro Teilnehmer (${participants.length})`), h('strong', {}, zeny(shareEach))),
        !open && unsold.length ? h('div', { class: 'panel' },
          h('div', { class: 'muted small' }, `Noch übrig (${unsold.length})`),
          h('strong', {}, '≈ ' + zeny(unsold.reduce((s, d) => s + (value(d) ?? 0), 0)))) : null,
      ),
      missingPrice ? h('p', { class: 'small', style: 'color:var(--accent)' },
        `${missingPrice} Zuteilung(en) ohne Preis – Partypreis zählt als 0. Admin kann den Preis mit ✎ festlegen.`) : null,
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, 'Spieler'), h('th', { class: 'hide-sm' }, 'Items'),
          h('th', { class: 'num' }, 'Zahlt'), h('th', { class: 'num' }, 'Erhält'), h('th', { class: 'num' }, 'Saldo'),
          showPaid ? h('th', {}, 'Ausgezahlt') : null)),
        h('tbody', {}, rowsSum.map((p) => h('tr', {},
          h('td', {}, p.uid === me.id ? h('strong', {}, p.name) : p.name),
          h('td', { class: 'small muted hide-sm' }, p.items.join(', ') || '–'),
          h('td', { class: 'num' }, zeny(p.pays)),
          h('td', { class: 'num' }, zeny(p.gets)),
          h('td', { class: 'num', style: `color:var(${p.saldo < 0 ? '--bad' : '--good'})` },
            (p.saldo > 0 ? '+' : '') + zeny(p.saldo)),
          showPaid ? h('td', {}, paidToggle(p)) : null,
        ))),
      )),
      h('p', { class: 'muted small' },
        'Negativer Saldo: an die Kasse zahlen. Positiver Saldo: bekommt Zeny aus der Kasse. Rest-Items sind gratis. ' +
        (!open && unsold.length ? 'Noch übrige Drops sind nicht enthalten.' : '')),
    );
  }

  const hints = {
    offen: 'Teilnehmer festlegen, Loot einfügen, Interesse anmelden. ★ = automatisch über deine Wunschliste. ' +
      'Admins markieren Müll (Müll-Liste der Party). Mit „Weiter: Müll verkaufen“ geht aller Müll an NPC – außer er ' +
      'steht auf der Wunschliste eines Teilnehmers, jemand hat Interesse eingetragen oder er ist zugewiesen.' +
      (trashToSell.length ? ` Aktuell ${trashToSell.length} Müll-Drop(s).` : ''),
    muell: 'Müll ist an NPC verkauft. Interessen können noch geändert werden, dann wird ausgewürfelt: ' +
      'Die Menge wird gleichmäßig auf alle Interessenten verteilt, den Rest bekommen die höchsten Würfe. ' +
      `Empfänger zahlen den Partypreis (${pct} %) in die Kasse.`,
    abholung: 'Jeder holt seinen Anteil im Guild Storage ab und hakt ihn ab (Admin und Verkäufer können für alle abhaken). ' +
      'Übrige Drops kann jedes Party-Mitglied mit „Nehme ich“ übernehmen – wer zuerst kommt, zahlt den Partypreis. ' +
      'Mit „Verkauf & Rest“ ist Schluss.',
    verkauf: 'Übrige Drops verkaufen (Erlös eintragen) oder nützlichen Rest gratis und zufällig an die Teilnehmer verteilen – jeder Eintrag geht komplett an eine Person. ' +
      'Der Rest wird mit der Auszahlung ausgehändigt.',
    auszahlung: 'Kasse und Verkäufe werden ausgezahlt und Rest-Items ausgehändigt. Admin oder Verkäufer haken pro Teilnehmer „Ausgezahlt“ und die Ausgabe ab.',
    beendet: `Run beendet${run.finished_at ? ' am ' + date(run.finished_at) : ''}.`,
  };

  let suggestBox = null;
  if (suggestions.length) {
    const picked = new Set(suggestions.map((s) => s.item_id));
    const addBtn = h('button', {
      class: 'primary',
      onclick: action(async () => {
        if (!picked.size) return;
        await q(sb.from('party_trash').insert([...picked].map((item_id) => ({ party_id: run.party_id, item_id }))));
        toast(`${picked.size} Item(s) auf die Müll-Liste gesetzt`);
        rerender();
      }),
    }, `Auf Müll-Liste setzen (${picked.size})`);
    suggestBox = h('div', { class: 'panel', style: 'margin:14px 0;border-color:var(--accent)' },
      // Kopfzeile mit Knopf bleibt beim Scrollen stehen, solange der Block sichtbar ist
      h('div', { class: 'row spread sticky-head' }, h('strong', {}, 'Vorschlag für die Müll-Liste'), addBtn),
      h('p', { class: 'muted small', style: 'margin:4px 0 8px' },
        'Diese Items wurden in den letzten 10 Runs der Party jedes Mal an NPC verkauft (mindestens in 2 Runs).'),
      h('ul', { class: 'list' }, suggestions.map((sug) => {
        const box = h('input', { type: 'checkbox' });
        box.checked = true;
        box.addEventListener('change', () => {
          box.checked ? picked.add(sug.item_id) : picked.delete(sug.item_id);
          addBtn.textContent = `Auf Müll-Liste setzen (${picked.size})`;
          addBtn.disabled = !picked.size;
        });
        return h('li', {},
          h('label', { class: 'row', style: 'flex-wrap:nowrap' }, box, icon(sug.icon), sug.name),
          h('span', { class: 'muted small', style: 'margin-left:auto' },
            `${sug.runs} Runs · ${sug.occurrences}× an NPC · NPC ${zeny(npcSell(sug.npc_price))}`));
      })),
    );
  }

  const sections = open
    ? [participantBox, importBox, summary]
    : status === 'beendet'
      ? [suggestBox, summary, pickupBox]
      : status === 'auszahlung'
        ? [summary, pickupBox]
      : [pickupBox, restBar, summary];

  return h('div', {},
    h('p', { class: 'small' }, h('a', { href: `#/party/${run.party_id}` }, '← ' + run.parties.name)),
    h('div', { class: 'row spread' },
      h('div', {},
        h('h1', {}, run.title, statusBadge(status),
          canManage ? h('button', {
            class: 'link small',
            onclick: action(async () => {
              const t = await textBox('Run umbenennen', null, run.title);
              if (!t || !t.trim() || t.trim() === run.title) return;
              await q(sb.from('runs').update({ title: t.trim() }).eq('id', id));
              rerender();
            }),
          }, 'umbenennen') : null),
        h('div', { class: 'muted small' },
          `${drops.length} Drops · Marktwert ≈ ${zeny(total)} · Partypreis ${pct} % · ${participants.length} Teilnehmer`
          + (run.rolled_at ? ` · gewürfelt ${date(run.rolled_at)}` : '')),
      ),
      h('div', { class: 'row' },
        canManage ? h('button', {
          class: 'small danger',
          onclick: action(async () => {
            if (!await confirmBox('Run löschen', `Run „${run.title}“ mit allem Loot endgültig löschen? Das lässt sich nicht rückgängig machen.`, 'Endgültig löschen', true)) return;
            await q(sb.from('runs').delete().eq('id', id));
            location.hash = `#/party/${run.party_id}`;
          }),
        }, 'Run löschen') : null,
        phaseButtons,
      ),
    ),
    stepper(status, drops.length > 0),
    h('p', { class: 'muted small' }, hints[status]),
    sections,
    drops.length ? h('h2', {}, 'Loot') : null,
    drops.length ? h('div', { class: 'row', style: 'margin-bottom:10px' }, filter,
      h('label', { class: 'row small muted' }, withoutRecipients, 'nur ohne Empfänger/Interessenten'),
      trashPhase ? h('label', { class: 'row small muted' }, onlyTrash, 'nur Müll anzeigen') : null,
      !trashPhase && soldTrashCount ? h('label', { class: 'row small muted' }, hideTrash, `Müll ausblenden (${soldTrashCount})`) : null)
      : null,
    table,
  );
}

// ---------- Wunschliste ----------

async function viewWishlist() {
  const list = await q(sb.from('wishlist').select('item_id, created_at, items(name, icon, slots, npc_price)')
    .order('created_at', { ascending: false }));
  const prices = list.length
    ? await q(sb.from('item_prices').select('item_id, sell_min, sell_median, buy_max').in('item_id', list.map((w) => w.item_id)))
    : [];
  const priceBy = new Map(prices.map((p) => [p.item_id, p]));
  const have = new Set(list.map((w) => w.item_id));

  const search = h('input', { type: 'search', placeholder: 'Item suchen (Name oder ID)' });
  const results = h('ul', { class: 'list' });
  search.addEventListener('input', debounce(async () => {
    const term = search.value.trim();
    if (term.length < 2 && !/^\d+$/.test(term)) return results.replaceChildren();
    try {
      let query = sb.from('items').select('item_id, name, icon, slots').limit(20);
      query = /^\d+$/.test(term) ? query.eq('item_id', Number(term)) : query.ilike('name', `%${term}%`).order('name');
      const found = await q(query);
      results.replaceChildren(...found.map((it) => h('li', {},
        icon(it.icon),
        h('span', {}, it.name + (it.slots ? ` [${it.slots}]` : '')),
        h('span', { class: 'muted small' }, `#${it.item_id}`),
        have.has(it.item_id)
          ? h('span', { class: 'badge good', style: 'margin-left:auto' }, 'auf der Liste')
          : h('button', {
              class: 'small', style: 'margin-left:auto',
              onclick: action(async () => {
                await q(sb.from('wishlist').insert({ item_id: it.item_id }));
                toast(`${it.name} hinzugefügt`);
                rerender();
              }),
            }, 'Hinzufügen'),
      )));
      if (!found.length) results.append(h('li', { class: 'muted small' }, 'Nichts gefunden.'));
    } catch (e) { toast(e.message, true); }
  }, 300));

  return h('div', {},
    h('h1', {}, 'Meine Wunschliste'),
    h('p', { class: 'muted small' },
      'Items auf deiner Wunschliste werden in allen deinen Partys automatisch als Interesse eingetragen, ' +
      'sobald sie in einem offenen Run auftauchen.'),
    h('div', { class: 'panel stack' }, search, results),
    h('h2', {}, `Auf der Liste (${list.length})`),
    list.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}), h('th', {}, 'Item'), h('th', { class: 'num' }, 'Verkauf ab'),
            h('th', { class: 'num' }, 'Median'), h('th', { class: 'num' }, 'Ankauf bis'),
            h('th', { class: 'num', title: '½ NPC-Preis + 24 % Overcharge' }, 'NPC'), h('th', {}),
          )),
          h('tbody', {}, list.map((w) => {
            const p = priceBy.get(w.item_id);
            return h('tr', {},
              h('td', {}, icon(w.items?.icon)),
              h('td', {}, (w.items?.name ?? `#${w.item_id}`) + (w.items?.slots ? ` [${w.items.slots}]` : '')),
              h('td', { class: 'num' }, zeny(p?.sell_min)),
              h('td', { class: 'num' }, zeny(p?.sell_median)),
              h('td', { class: 'num' }, zeny(p?.buy_max)),
              h('td', { class: 'num' }, zeny(npcSell(w.items?.npc_price))),
              h('td', {}, h('button', {
                class: 'small danger',
                onclick: action(async () => {
                  await q(sb.from('wishlist').delete().eq('item_id', w.item_id).eq('user_id', me.id));
                  rerender();
                }),
              }, 'Entfernen')),
            );
          })),
        ))
      : h('p', { class: 'muted' }, 'Noch leer.'),
  );
}

// ---------- Start ----------

sb.auth.onAuthStateChange((event, session) => {
  const changed = (session?.user?.id ?? null) !== (me?.id ?? null);
  me = session?.user ?? null;
  // ?code=... nach dem Login aus der Adresse entfernen
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  // außerhalb des Callbacks rendern – Supabase-Aufrufe darin können sonst blockieren
  if (changed || event === 'INITIAL_SESSION') setTimeout(route);
});
