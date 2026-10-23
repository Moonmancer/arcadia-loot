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
    if (seq === renderSeq) $app.replaceChildren(view);
  } catch (e) {
    if (seq === renderSeq) $app.replaceChildren(h('p', { class: 'muted' }, 'Fehler: ' + e.message));
  }
}

const rerender = () => route();
window.addEventListener('hashchange', route);

// ---------- Partys ----------

async function viewParties() {
  const parties = await q(sb.from('parties')
    .select('id, name, created_at, party_members(count), runs(count)')
    .order('created_at', { ascending: false }));

  const name = h('input', { type: 'text', placeholder: 'Name der neuen Party', maxlength: 60 });
  const create = action(async () => {
    if (!name.value.trim()) return name.focus();
    const p = await q(sb.from('parties').insert({ name: name.value.trim() }).select('id').single());
    location.hash = `#/party/${p.id}`;
  });
  name.addEventListener('keydown', (e) => e.key === 'Enter' && create(e));

  return h('div', {},
    h('h1', {}, 'Meine Partys'),
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
  const [party, members, runs] = await Promise.all([
    q(sb.from('parties').select('id, name, created_by, party_price_pct').eq('id', id).maybeSingle()),
    q(sb.from('party_members').select('user_id, role, profiles(display_name, avatar_url)').eq('party_id', id)),
    q(sb.from('runs').select('id, title, status, created_at, drops(count)').eq('party_id', id)
      .order('created_at', { ascending: false })),
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
              if (!confirm(`Party „${party.name}" wirklich verlassen?`)) return;
              await q(sb.from('party_members').delete().eq('party_id', id).eq('user_id', me.id));
              location.hash = '#/';
            }),
          }, 'Verlassen')
        : isAdmin
          ? h('button', {
              class: 'small danger',
              onclick: action(async () => {
                if (!confirm(`${m.profiles.display_name} aus der Party entfernen?`)) return;
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
      const n = prompt('Neuer Name der Party', party.name);
      if (!n || !n.trim()) return;
      await q(sb.from('parties').update({ name: n.trim() }).eq('id', id));
      rerender();
    }),
  }, 'umbenennen');

  const del = isAdmin && h('button', {
    class: 'small danger',
    onclick: action(async () => {
      if (!confirm(`Party „${party.name}" mit allen Runs endgültig löschen?`)) return;
      await q(sb.from('parties').delete().eq('id', id));
      location.hash = '#/';
    }),
  }, 'Party löschen');

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
    h('p', { class: 'muted small' },
      'Admin: Mitglieder, Rollen, Partypreis, alle Runs, Preise überschreiben, Items zuweisen. ' +
      'Verkäufer: Verkaufserlöse erfassen. Teilnehmer: Interesse eintragen, eigene Runs anlegen.'),
  );
}

// ---------- Run ----------

const PHASES = ['offen', 'abholung', 'verkauf', 'auszahlung', 'beendet'];
const PHASE_LABEL = {
  offen: 'Loot & Interessen', abholung: 'Abholung', verkauf: 'Verkauf & Rest', auszahlung: 'Auszahlung', beendet: 'Beendet',
};
const statusBadge = (status) => h('span', { class: 'badge ' + (status === 'beendet' ? '' : status === 'offen' ? 'warn' : 'good') },
  PHASE_LABEL[status]);

// Fortschrittsleiste: Erstellen → Loot → Würfeln → Abholung → Verkauf/Rest → Auszahlung → Beendet
function stepper(status, hasDrops) {
  const phase = PHASES.indexOf(status);
  const steps = [
    ['Erstellt', true],
    ['Loot befüllt', hasDrops],
    ['Ausgewürfelt', phase >= 1],
    ['Abholung', phase > 1],
    ['Verkauf & Rest', phase > 2],
    ['Auszahlung', phase > 3],
    ['Beendet', phase >= 4],
  ];
  const current = status === 'offen' ? (hasDrops ? 2 : 1) : status === 'beendet' ? 6 : phase + 2;
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

  const status = run.status;
  const open = status === 'offen';
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

  // Stückpreis: Override des Admins, sonst Marktpreis (nur für normale Items aussagekräftig)
  // Stückpreis: Override des Admins, sonst Marktpreis (nur normale Items), sonst NPC-Verkaufspreis
  const unit = (d) => d.price_override ?? (d.is_plain ? unitPrice(d) : null) ?? npcSell(d.npc_price);
  const value = (d, amount = d.amount) => (unit(d) != null ? unit(d) * amount : null);
  const partyPrice = (d, amount = d.amount) => (unit(d) != null ? Math.round(unit(d) * amount * pct / 100) : null);
  const total = drops.reduce((s, d) => s + (value(d) ?? 0), 0);
  const leftovers = drops.filter((d) => !byDrop.has(d.id));          // ohne Empfänger
  const unsold = leftovers.filter((d) => d.sold_price == null);
  const handouts = interests.filter((i) => i.share > 0 && !(open && dropById.get(i.drop_id)?.assigned_to == null));

  const changeStatus = (to, question) => action(async () => {
    if (question && !confirm(question)) return;
    await q(sb.rpc('set_run_status', { p_run: id, p_status: to }));
    rerender();
  });

  // ----- Kopf mit Phasen-Aktionen -----
  const phaseButtons = [];
  if (open && canManage && drops.length) {
    phaseButtons.push(h('button', {
      class: 'primary',
      onclick: action(async () => {
        if (!confirm('Jetzt würfeln? Danach können keine Interessen mehr geändert werden.')) return;
        await q(sb.rpc('roll_run', { p_run: id }));
        toast('Gewürfelt – Abholung beginnt');
        rerender();
      }),
    }, 'Auswürfeln'));
  }
  if (canAdvance && !open) {
    const i = PHASES.indexOf(status);
    if (i > 1) phaseButtons.push(h('button', { class: 'small', onclick: changeStatus(PHASES[i - 1]) }, `← ${PHASE_LABEL[PHASES[i - 1]]}`));
    const openPickups = handouts.filter((x) => !x.picked_up_at).length;
    if (status === 'abholung') {
      phaseButtons.push(h('button', {
        class: 'primary',
        onclick: changeStatus('verkauf', openPickups ? `${openPickups} Anteil(e) noch nicht abgeholt. Trotzdem weiter zu Verkauf & Rest?` : null),
      }, 'Weiter: Verkauf & Rest →'));
    } else if (status === 'verkauf') {
      const warn = [unsold.length && `${unsold.length} Drop(s) weder verkauft noch aufgeteilt`,
        openPickups && `${openPickups} Anteil(e) nicht abgeholt`].filter(Boolean).join(', ');
      phaseButtons.push(h('button', {
        class: 'primary',
        onclick: changeStatus('auszahlung', warn ? `${warn}. Trotzdem weiter zur Auszahlung?` : null),
      }, 'Weiter: Auszahlung →'));
    } else if (status === 'auszahlung') {
      const unpaid = participants.filter((p) => !p.paid_at).length;
      phaseButtons.push(h('button', {
        class: 'primary',
        onclick: changeStatus('beendet', unpaid ? `${unpaid} Teilnehmer noch nicht ausgezahlt. Run trotzdem beenden?` : 'Run beenden?'),
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
  if (open && canManage) {
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
    const allowed = !finished && (i.user_id === me.id || isSeller) && status !== 'offen';
    const box = h('input', { type: 'checkbox', disabled: !allowed });
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
  if (!open && handouts.length) {
    const byUser = new Map();
    for (const i of handouts) {
      if (!byUser.has(i.user_id)) byUser.set(i.user_id, { name: i.profiles.display_name, list: [] });
      byUser.get(i.user_id).list.push(i);
    }
    const done = handouts.filter((i) => i.picked_up_at).length;
    pickupBox = h('div', {},
      h('h2', {}, `Ausgabe (${done}/${handouts.length} abgeholt)`),
      h('div', { class: 'cards' }, [...byUser.entries()]
        .sort((a, b) => (a[0] === me.id ? -1 : b[0] === me.id ? 1 : a[1].name.localeCompare(b[1].name)))
        .map(([uid, u]) => {
          const all = u.list.every((i) => i.picked_up_at);
          return h('div', { class: 'panel', style: uid === me.id ? 'border-color:var(--accent)' : '' },
            h('div', { class: 'row spread' }, h('strong', {}, u.name),
              all ? h('span', { class: 'badge good' }, 'alles abgeholt') : h('span', { class: 'badge warn' }, 'offen')),
            h('ul', { class: 'list' }, u.list.map((i) => h('li', { class: 'small' },
              h('label', { class: 'row', style: 'flex-wrap:nowrap' }, pickToggle(i),
                `${zenyFmt.format(i.share)}× ${dropById.get(i.drop_id).name}`,
                i.source === 'rest' ? h('span', { class: 'badge' }, 'Rest') : null),
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
    const input = prompt(`Stückpreis für ${d.name} (leer = Marktpreis)`, d.price_override ?? unitPrice(d) ?? '');
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
      if (!confirm(`${n} Drop(s) gratis und zufällig an die ${participants.length} Teilnehmer verteilen? Jeder Eintrag geht komplett an eine Person.`)) return;
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
      if (!confirm(`${list.length} übrige Drop(s) für zusammen ${zeny(sum)} an NPC verkaufen? Als Rest markierte bleiben übrig.`)) return;
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
  const onlyInterest = h('input', { type: 'checkbox' });

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
      else if (i.source === 'rest') label += ` ${i.share}×`;
      else if (!open) label += ` ${i.roll}` + (d.amount > 1 ? ` → ${i.share}×` : '');
      else if (i.source === 'wunschliste') label += ' ★';
      if (i.picked_up_at) label += ' ✓';
      return h('span', { class: cls, title: i.picked_up_at ? 'abgeholt' : i.source === 'wunschliste' ? 'über Wunschliste' : '' }, label);
    }));
    if (isRest) chips.prepend(h('span', { class: 'badge', style: 'margin:0 4px 0 0' }, 'Rest'));
    if (!list.length) {
      chips.append(open
        ? h('span', { class: 'muted small' }, '–')
        : d.sold_price != null
          ? h('span', { class: 'chip win' }, `${d.sold_to_npc ? 'an NPC verkauft' : 'verkauft'} ${zeny(d.sold_price)}`)
          : h('span', { class: 'muted small' }, 'übrig'));
    }

    const priceCell = h('td', { class: 'num hide-sm' },
      d.price_override != null
        ? h('span', { title: 'Vom Admin festgelegt' }, zeny(d.price_override), h('span', { class: 'badge warn' }, 'fest'))
        : d.is_plain && unitPrice(d) != null ? zeny(unitPrice(d))
        : npcSell(d.npc_price) != null
          ? h('span', { title: d.is_plain ? 'Kein Marktpreis – NPC-Verkaufspreis als Ersatz' : 'Marktpreis gilt nur für normale Items – NPC-Verkaufspreis als Ersatz' },
              zeny(npcSell(d.npc_price)), h('span', { class: 'badge' }, 'NPC'))
          : '–',
      isAdmin && ['offen', 'abholung', 'verkauf'].includes(status)
        ? h('button', { class: 'link small', title: 'Preis überschreiben', onclick: editPrice(d) }, '✎') : null);

    const actions = [];
    if (open && !assigned && amParticipant) {
      actions.push(h('button', { class: 'small' + (mine ? ' on' : ''), onclick: toggleInterest(d, mine) }, mine ? 'Will ich ✓' : 'Will ich'));
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
    if (isAdmin && ['offen', 'abholung', 'verkauf'].includes(status) && !isRest) actions.push(assignSelect(d));
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
    return tr;
  });

  const applyFilter = () => {
    const term = filter.value.trim().toLowerCase();
    for (const tr of rows) {
      tr.hidden = (term && !tr.dataset.search.includes(term)) || (onlyInterest.checked && !tr.dataset.interest);
    }
  };
  filter.addEventListener('input', applyFilter);
  onlyInterest.addEventListener('change', applyFilter);

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
    const people = new Map(participants.map((p) => [p.user_id, { name: p.profiles.display_name, items: [], pays: 0, paid_at: p.paid_at }]));
    let pot = 0;
    let missingPrice = 0;
    for (const i of handouts) {
      const d = dropById.get(i.drop_id);
      const p = people.get(i.user_id) ?? { name: i.profiles.display_name, items: [], pays: 0 };
      people.set(i.user_id, p);
      p.items.push(`${i.share}× ${d.name}` + (i.source === 'rest' ? ' (Rest)' : ''));
      if (i.source === 'rest') continue;                       // Rest ist gratis
      const pp = partyPrice(d, i.share);
      if (pp == null) missingPrice++;
      p.pays += pp ?? 0;
      pot += pp ?? 0;
    }
    const sold = leftovers.filter((d) => d.sold_price != null);
    const sales = sold.reduce((s, d) => s + d.sold_price, 0);
    const shareEach = participants.length ? Math.floor((pot + sales) / participants.length) : 0;
    const partIds = new Set(participants.map((p) => p.user_id));
    const rowsSum = [...people.entries()]
      .map(([uid, p]) => ({ uid, ...p, gets: partIds.has(uid) ? shareEach : 0 }))
      .map((p) => ({ ...p, saldo: p.gets - p.pays }))
      .sort((a, b) => a.saldo - b.saldo);
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
      'Beim Würfeln wird die Menge gleichmäßig auf alle Interessenten verteilt, den Rest bekommen die höchsten Würfe. ' +
      `Empfänger zahlen den Partypreis (${pct} %) in die Kasse.`,
    abholung: 'Jeder holt seinen Anteil im Guild Storage ab und hakt ihn ab (Admin und Verkäufer können für alle abhaken).',
    verkauf: 'Übrige Drops verkaufen (Erlös eintragen) oder nützlichen Rest gratis und zufällig an die Teilnehmer verteilen – jeder Eintrag geht komplett an eine Person.',
    auszahlung: 'Kasse und Verkäufe werden ausgezahlt. Admin oder Verkäufer haken pro Teilnehmer „Ausgezahlt“ ab.',
    beendet: `Run beendet${run.finished_at ? ' am ' + date(run.finished_at) : ''}.`,
  };

  const sections = status === 'offen'
    ? [participantBox, importBox, summary]
    : status === 'auszahlung' || status === 'beendet'
      ? [summary, pickupBox]
      : [pickupBox, restBar, summary];

  return h('div', {},
    h('p', { class: 'small' }, h('a', { href: `#/party/${run.party_id}` }, '← ' + run.parties.name)),
    h('div', { class: 'row spread' },
      h('div', {},
        h('h1', {}, run.title, statusBadge(status)),
        h('div', { class: 'muted small' },
          `${drops.length} Drops · Marktwert ≈ ${zeny(total)} · Partypreis ${pct} % · ${participants.length} Teilnehmer`
          + (run.rolled_at ? ` · gewürfelt ${date(run.rolled_at)}` : '')),
      ),
      h('div', { class: 'row' },
        canManage ? h('button', {
          class: 'small danger',
          onclick: action(async () => {
            if (!confirm(`Run „${run.title}" endgültig löschen?`)) return;
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
      h('label', { class: 'row small muted' }, onlyInterest, 'nur mit Empfängern/Interessenten')) : null,
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
