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
        r.status === 'offen' ? h('span', { class: 'badge warn' }, 'offen') : h('span', { class: 'badge good' }, 'gewürfelt'),
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

async function viewRun(id) {
  id = Number(id);
  const run = await q(sb.from('runs')
    .select('id, title, status, created_by, created_at, rolled_at, party_id, parties(name, party_price_pct)')
    .eq('id', id).maybeSingle());
  if (!run) return h('p', { class: 'muted' }, 'Run nicht gefunden oder kein Zugriff.');

  const [drops, interests, members, wishlist] = await Promise.all([
    q(sb.from('drop_overview').select('*').eq('run_id', id).order('pos')),
    q(sb.from('interests').select('drop_id, user_id, roll, share, source, profiles(display_name), drops!inner(run_id)')
      .eq('drops.run_id', id)),
    q(sb.from('party_members').select('user_id, role, profiles(display_name)').eq('party_id', run.party_id)),
    q(sb.from('wishlist').select('item_id')),
  ]);

  const open = run.status === 'offen';
  const myRole = members.find((m) => m.user_id === me.id)?.role;
  const isAdmin = myRole === 'admin';
  const isSeller = isAdmin || myRole === 'verkaeufer';
  const canManage = run.created_by === me.id || isAdmin;
  const pct = run.parties.party_price_pct;
  members.sort(byRoleAndName);
  const wished = new Set(wishlist.map((w) => w.item_id));
  const byDrop = new Map();
  for (const i of interests) {
    if (!byDrop.has(i.drop_id)) byDrop.set(i.drop_id, []);
    byDrop.get(i.drop_id).push(i);
  }
  for (const list of byDrop.values()) {
    list.sort((a, b) => (b.roll ?? 0) - (a.roll ?? 0) || a.profiles.display_name.localeCompare(b.profiles.display_name));
  }

  // Stückpreis: Override des Admins, sonst Marktpreis (nur für normale Items aussagekräftig)
  const unit = (d) => d.price_override ?? (d.is_plain ? unitPrice(d) : null);
  const value = (d, amount = d.amount) => (unit(d) != null ? unit(d) * amount : null);
  const partyPrice = (d, amount = d.amount) => (unit(d) != null ? Math.round(unit(d) * amount * pct / 100) : null);
  const total = drops.reduce((s, d) => s + (value(d) ?? 0), 0);

  // Import
  let importBox = null;
  if (open && canManage) {
    const text = h('textarea', { placeholder: 'Guild-Storage-Liste hier einfügen (ID, Name, Amount, Attributes, Cards – tab-getrennt)' });
    importBox = h('details', { class: 'panel', open: drops.length === 0 },
      h('summary', {}, drops.length ? 'Weitere Liste einfügen' : 'Liste einfügen'),
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

  // Würfeln
  const rollBtn = open && canManage && drops.length > 0 && h('button', {
    class: 'primary',
    onclick: action(async () => {
      if (!confirm('Jetzt würfeln? Danach können keine Interessen mehr geändert werden.')) return;
      await q(sb.rpc('roll_run', { p_run: id }));
      toast('Gewürfelt!');
      rerender();
    }),
  }, 'Würfeln');

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
      members.map((m) => h('option', { value: m.user_id }, '→ ' + m.profiles.display_name)));
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
    if (!isSeller) return d.sold_price != null ? zeny(d.sold_price) : null;
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

  // Filter
  const filter = h('input', { type: 'search', placeholder: 'Filtern …' });
  const onlyInterest = h('input', { type: 'checkbox' });

  const rows = drops.map((d) => {
    const list = byDrop.get(d.id) || [];
    const mine = list.some((i) => i.user_id === me.id);
    const assigned = d.assigned_to != null;
    const chips = h('div', { class: 'chips' }, list.map((i) => {
      const done = !open || assigned;
      const cls = ['chip', i.user_id === me.id && 'me', done && (i.share > 0 ? 'win' : 'lose')].filter(Boolean).join(' ');
      let label = i.profiles.display_name;
      if (i.source === 'zuweisung') label += ` → ${i.share}× (zugewiesen)`;
      else if (!open) label += ` ${i.roll}` + (d.amount > 1 ? ` → ${i.share}×` : '');
      else if (i.source === 'wunschliste') label += ' ★';
      return h('span', { class: cls, title: i.source === 'wunschliste' ? 'über Wunschliste' : '' }, label);
    }));
    if (!list.length) {
      chips.append(open
        ? h('span', { class: 'muted small' }, '–')
        : d.sold_price != null
          ? h('span', { class: 'chip win' }, `verkauft ${zeny(d.sold_price)}`)
          : h('span', { class: 'muted small' }, 'verkaufen'));
    }

    const priceCell = h('td', { class: 'num hide-sm' },
      d.price_override != null
        ? h('span', { title: 'Vom Admin festgelegt' }, zeny(d.price_override), h('span', { class: 'badge warn' }, 'fest'))
        : d.is_plain ? zeny(unitPrice(d)) : h('span', { class: 'muted', title: 'Marktpreis gilt nur für normale Items' }, zeny(unitPrice(d))),
      isAdmin ? h('button', { class: 'link small', title: 'Preis überschreiben', onclick: editPrice(d) }, '✎') : null);

    const actions = [];
    if (open && !assigned) {
      actions.push(h('button', { class: 'small' + (mine ? ' on' : ''), onclick: toggleInterest(d, mine) }, mine ? 'Will ich ✓' : 'Will ich'));
    }
    if (!open && !list.length && (isSeller || d.sold_price != null)) actions.push(saleControl(d));
    if (isAdmin) actions.push(assignSelect(d));
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
      h('td', { class: 'num hide-sm' }, zeny(value(d))),
      h('td', { class: 'num' }, zeny(partyPrice(d))),
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

  const table = drops.length
    ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { class: 'hide-sm' }), h('th', {}, 'Item'), h('th', { class: 'num' }, 'Menge'),
          h('th', { class: 'num hide-sm' }, 'Stückpreis'), h('th', { class: 'num hide-sm' }, 'Gesamt'),
          h('th', { class: 'num', title: `${pct} % vom Gesamtpreis` }, `Partypreis ${pct} %`),
          h('th', {}, open ? 'Interessenten' : 'Ergebnis'), h('th', {}),
        )),
        h('tbody', {}, rows),
      ))
    : h('p', { class: 'muted' }, 'Noch keine Drops.');

  // Abrechnung: Empfänger zahlen den Partypreis in die Kasse, Kasse + Verkäufe werden geteilt
  let summary = null;
  const settled = drops.filter((d) => !open || d.assigned_to != null);
  if (drops.length && settled.length) {
    const people = new Map(members.map((m) => [m.user_id, { name: m.profiles.display_name, items: [], pays: 0 }]));
    let pot = 0;
    let missingPrice = 0;
    for (const i of interests) {
      const d = drops.find((x) => x.id === i.drop_id);
      if (!i.share || (open && d.assigned_to == null)) continue;
      const p = people.get(i.user_id) ?? { name: i.profiles.display_name, items: [], pays: 0 };
      people.set(i.user_id, p);
      p.items.push(`${i.share}× ${d.name}`);
      const pp = partyPrice(d, i.share);
      if (pp == null) missingPrice++;
      p.pays += pp ?? 0;
      pot += pp ?? 0;
    }
    const sold = open ? [] : drops.filter((d) => !byDrop.has(d.id) && d.sold_price != null);
    const unsold = open ? [] : drops.filter((d) => !byDrop.has(d.id) && d.sold_price == null);
    const sales = sold.reduce((s, d) => s + d.sold_price, 0);
    const shareEach = members.length ? Math.floor((pot + sales) / members.length) : 0;

    const rowsSum = [...people.entries()].map(([uid, p]) => ({ uid, ...p, gets: members.some((m) => m.user_id === uid) ? shareEach : 0 }))
      .map((p) => ({ ...p, saldo: p.gets - p.pays }))
      .sort((a, b) => a.saldo - b.saldo);

    summary = h('div', {},
      h('h2', {}, open ? 'Abrechnung (bisher zugewiesen)' : 'Abrechnung'),
      h('div', { class: 'cards', style: 'margin-bottom:10px' },
        h('div', { class: 'panel' }, h('div', { class: 'muted small' }, 'Kasse aus Partypreisen'), h('strong', {}, zeny(pot))),
        h('div', { class: 'panel' }, h('div', { class: 'muted small' }, `Verkäufe (${sold.length})`), h('strong', {}, zeny(sales))),
        h('div', { class: 'panel' }, h('div', { class: 'muted small' }, `Anteil pro Mitglied (${members.length})`), h('strong', {}, zeny(shareEach))),
        unsold.length ? h('div', { class: 'panel' },
          h('div', { class: 'muted small' }, `Noch zu verkaufen (${unsold.length})`),
          h('strong', {}, '≈ ' + zeny(unsold.reduce((s, d) => s + (value(d) ?? 0), 0)))) : null,
      ),
      missingPrice ? h('p', { class: 'small', style: 'color:var(--accent)' },
        `${missingPrice} Zuteilung(en) ohne Preis – Partypreis zählt als 0. Admin kann den Preis mit ✎ festlegen.`) : null,
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, 'Spieler'), h('th', { class: 'hide-sm' }, 'Items'),
          h('th', { class: 'num' }, 'Zahlt'), h('th', { class: 'num' }, 'Erhält'), h('th', { class: 'num' }, 'Saldo'))),
        h('tbody', {}, rowsSum.map((p) => h('tr', {},
          h('td', {}, p.uid === me.id ? h('strong', {}, p.name) : p.name),
          h('td', { class: 'small muted hide-sm' }, p.items.join(', ') || '–'),
          h('td', { class: 'num' }, zeny(p.pays)),
          h('td', { class: 'num' }, zeny(p.gets)),
          h('td', { class: 'num', style: `color:var(${p.saldo < 0 ? '--bad' : '--good'})` },
            (p.saldo > 0 ? '+' : '') + zeny(p.saldo)),
        ))),
      )),
      h('p', { class: 'muted small' },
        'Negativer Saldo: an die Kasse zahlen. Positiver Saldo: bekommt Zeny aus der Kasse. ' +
        (unsold.length ? 'Noch nicht verkaufte Drops sind nicht enthalten.' : '')),
    );
  }

  return h('div', {},
    h('p', { class: 'small' }, h('a', { href: `#/party/${run.party_id}` }, '← ' + run.parties.name)),
    h('div', { class: 'row spread' },
      h('div', {},
        h('h1', {}, run.title,
          open ? h('span', { class: 'badge warn' }, 'offen') : h('span', { class: 'badge good' }, 'gewürfelt')),
        h('div', { class: 'muted small' },
          `${drops.length} Drops · Marktwert ≈ ${zeny(total)} · Partypreis ${pct} %`
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
        rollBtn,
      ),
    ),
    open ? h('p', { class: 'muted small' },
      'Markiere, was du willst. ★ = automatisch über deine Wunschliste; „☆ Wunschliste" setzt ein Item für alle künftigen Runs darauf. ' +
      'Beim Würfeln wird die Menge gleichmäßig auf alle Interessenten verteilt, den Rest bekommen die höchsten Würfe. ' +
      `Wer ein Item bekommt, zahlt den Partypreis (${pct} %) in die Kasse; Kasse und Verkäufe werden auf alle Mitglieder geteilt.`) : null,
    importBox ? h('div', { style: 'margin:14px 0' }, importBox) : null,
    summary,
    drops.length ? h('div', { class: 'row', style: 'margin:18px 0 10px' }, filter,
      h('label', { class: 'row small muted' }, onlyInterest, 'nur mit Interessenten')) : null,
    table,
  );
}

// ---------- Wunschliste ----------

async function viewWishlist() {
  const list = await q(sb.from('wishlist').select('item_id, created_at, items(name, icon, slots)')
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
            h('th', { class: 'num' }, 'Median'), h('th', { class: 'num' }, 'Ankauf bis'), h('th', {}),
          )),
          h('tbody', {}, list.map((w) => {
            const p = priceBy.get(w.item_id);
            return h('tr', {},
              h('td', {}, icon(w.items?.icon)),
              h('td', {}, (w.items?.name ?? `#${w.item_id}`) + (w.items?.slots ? ` [${w.items.slots}]` : '')),
              h('td', { class: 'num' }, zeny(p?.sell_min)),
              h('td', { class: 'num' }, zeny(p?.sell_median)),
              h('td', { class: 'num' }, zeny(p?.buy_max)),
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
