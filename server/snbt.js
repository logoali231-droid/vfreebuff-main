// snbt.js — SNBT (Stringified NBT) parser, serializer and FTB Quests chapter
// validator. Tolerant parser (accepts vanilla comma style and FTB's newline
// style), strict serializer (canonical vanilla style: quoted strings, typed
// number suffixes, commas), plus a normalizer that repairs LLM output so the
// FTB Quests mod can load the files without crashing.
import crypto from 'node:crypto';

/* ------------------------------------------------------------------ *
 * AST node types
 *   { k: 'compound', entries: Map<string, Node> }
 *   { k: 'list',     items: Node[] }
 *   { k: 'array',    kind: 'byte'|'int'|'long', items: number[] }
 *   { k: 'string',   v: string }
 *   { k: 'num',      v: number, kind: 'byte'|'short'|'int'|'long'|'float'|'double' }
 *   { k: 'bool',     v: boolean }
 * ------------------------------------------------------------------ */

const BARE_KEY = /^[A-Za-z0-9_\-.+]+$/;
const HEX_ID = /^[0-9A-Fa-f]{16}$/;
const ITEM_ID = /^[a-z0-9_.\-]+:[a-z0-9_./\-]+$/;

/* ----------------------------- Parser ---------------------------- */

class SnbtParser {
  constructor(text) {
    this.s = text;
    this.i = 0;
  }

  fail(msg) {
    const line = this.s.slice(0, this.i).split('\n').length;
    throw new Error(`SNBT parse error at line ${line}: ${msg}`);
  }

  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  peek() { this.ws(); return this.s[this.i]; }

  expect(ch) {
    if (this.s[this.i] !== ch) this.fail(`expected '${ch}' but found '${this.s[this.i] ?? 'EOF'}'`);
    this.i++;
  }

  parse() {
    const v = this.value();
    this.ws();
    if (this.i < this.s.length) this.fail(`trailing content '${this.s.slice(this.i, this.i + 20)}'`);
    return v;
  }

  value() {
    const c = this.peek();
    if (c === undefined) this.fail('unexpected end of input');
    if (c === '{') return this.compound();
    if (c === '[') return this.arrayOrList();
    if (c === '"' || c === "'") return { k: 'string', v: this.quoted(c) };
    return this.bare();
  }

  compound() {
    this.expect('{');
    const entries = new Map();
    for (;;) {
      const c = this.peek();
      if (c === '}') { this.i++; break; }
      if (c === undefined) this.fail('unterminated compound');
      if (c === ',') { this.i++; continue; }        // tolerate stray commas
      const key = (c === '"' || c === "'") ? this.quoted(c) : this.bareToken();
      this.ws();
      if (this.s[this.i] !== ':') this.fail(`expected ':' after key '${key}'`);
      this.i++;
      const val = this.value();
      entries.set(key, val);
      this.ws();
      if (this.s[this.i] === ',') this.i++;          // commas optional (FTB style)
    }
    return { k: 'compound', entries };
  }

  arrayOrList() {
    this.expect('[');
    // Typed arrays: [B; ...] [I; ...] [L; ...]
    const save = this.i;
    const m = /^\s*([BILbil]);/.exec(this.s.slice(this.i));
    if (m) {
      this.i += m[0].length;
      const kind = m[1].toUpperCase() === 'B' ? 'byte' : m[1].toUpperCase() === 'I' ? 'int' : 'long';
      const items = [];
      for (;;) {
        const c = this.peek();
        if (c === ']') { this.i++; break; }
        if (c === undefined) this.fail('unterminated typed array');
        if (c === ',') { this.i++; continue; }
        const v = this.value();
        if (v.k !== 'num') this.fail('typed array must contain numbers');
        items.push(v.v);
        this.ws();
        if (this.s[this.i] === ',') this.i++;
      }
      return { k: 'array', kind, items };
    }
    this.i = save;
    const items = [];
    for (;;) {
      const c = this.peek();
      if (c === ']') { this.i++; break; }
      if (c === undefined) this.fail('unterminated list');
      if (c === ',') { this.i++; continue; }
      items.push(this.value());
      this.ws();
      if (this.s[this.i] === ',') this.i++;
    }
    return { k: 'list', items };
  }

  quoted(quote) {
    this.i++; // opening quote
    let out = '';
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined) this.fail('unterminated string');
      if (c === '\\') {
        const n = this.s[this.i + 1];
        const map = { n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '\\': '\\' };
        if (n in map) { out += map[n]; this.i += 2; continue; }
        out += n ?? '';
        this.i += 2;
        continue;
      }
      if (c === quote) { this.i++; return out; }
      out += c;
      this.i++;
    }
  }

  bareToken() {
    const start = this.i;
    while (this.i < this.s.length && !/[\s:{}[\],]/.test(this.s[this.i])) this.i++;
    if (this.i === start) this.fail('expected a value');
    return this.s.slice(start, this.i);
  }

  bare() {
    const tok = this.bareToken();
    if (tok === 'true') return { k: 'bool', v: true };
    if (tok === 'false') return { k: 'bool', v: false };
    const num = /^([-+]?(?:\d+\.?\d*|\.\d+))([bBsSlLfFdD])?$/.exec(tok);
    if (num) {
      const v = Number(num[1]);
      const suf = num[2] ? num[2].toLowerCase() : null;
      if (suf === null) return { k: 'num', v, kind: num[1].includes('.') ? 'double' : 'int' };
      const kind = { b: 'byte', s: 'short', l: 'long', f: 'float', d: 'double' }[suf];
      return { k: 'num', v, kind };
    }
    return { k: 'string', v: tok };
  }
}

export function parseSnbt(text) {
  return new SnbtParser(text).parse();
}

/* --------------------------- Serializer --------------------------- */

function fmtNumber(v, kind) {
  if (kind === 'double') {
    const s = Number.isInteger(v) && Math.abs(v) < 1e15 ? `${v}.0` : String(v);
    return `${s}d`;
  }
  if (kind === 'float') return `${v}f`;
  if (kind === 'long') return `${String(BigInt(Math.trunc(v)))}L`;
  if (kind === 'byte') return `${v}b`;
  if (kind === 'short') return `${v}s`;
  return String(v);
}

function quote(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r')}"`;
}

function keyText(k) { return BARE_KEY.test(k) ? k : quote(k); }

function strText(s) {
  // Bare only for safe, unambiguous tokens; quoted otherwise (spaces, colons...).
  if (BARE_KEY.test(s) && !/^(true|false)$/.test(s) && !/^[-+]?[0-9]/.test(s)) return s;
  return quote(s);
}

function scalarText(node) {
  switch (node.k) {
    case 'string': return strText(node.v);
    case 'num': return fmtNumber(node.v, node.kind);
    case 'bool': return node.v ? 'true' : 'false';
    default: return null;
  }
}

export function stringifySnbt(node, indent = 0) {
  const pad = '  '.repeat(indent);
  const padIn = '  '.repeat(indent + 1);

  if (node.k === 'compound') {
    if (node.entries.size === 0) return '{ }';
    const parts = [...node.entries].map(([k, v]) => `${padIn}${keyText(k)}: ${stringifySnbt(v, indent + 1)}`);
    return `{\n${parts.join(',\n')}\n${pad}}`;
  }
  if (node.k === 'list') {
    if (node.items.length === 0) return '[ ]';
    const inline = node.items.every((it) => it.k !== 'compound');
    if (inline) return `[${node.items.map((it) => stringifySnbt(it, 0)).join(', ')}]`;
    const parts = node.items.map((it) => `${padIn}${stringifySnbt(it, indent + 1)}`);
    return `[\n${parts.join(',\n')}\n${pad}]`;
  }
  if (node.k === 'array') {
    const suf = node.kind === 'byte' ? 'b' : node.kind === 'long' ? 'L' : '';
    return `[${node.kind === 'byte' ? 'B' : node.kind === 'long' ? 'L' : 'I'}; ${node.items.map((v) => `${v}${suf}`).join(', ')}]`;
  }
  return scalarText(node);
}

/* ------------------------- Node constructors ----------------------- */

export const n = {
  str: (v) => ({ k: 'string', v: String(v) }),
  num: (v, kind = 'int') => ({ k: 'num', v: Number(v), kind }),
  d: (v) => ({ k: 'num', v: Number(v), kind: 'double' }),
  l: (v) => ({ k: 'num', v: Math.trunc(Number(v)), kind: 'long' }),
  i: (v) => ({ k: 'num', v: Math.trunc(Number(v)), kind: 'int' }),
  bool: (v) => ({ k: 'bool', v: Boolean(v) }),
  compound: (obj = {}) => ({ k: 'compound', entries: new Map(Object.entries(obj)) }),
  list: (items = []) => ({ k: 'list', items }),
};

export function isCompound(node) { return node && node.k === 'compound'; }
export function isList(node) { return node && node.k === 'list'; }

/** Convert an SNBT AST into plain JS (objects/arrays/numbers/strings). */
export function toJs(node) {
  if (!node) return null;
  switch (node.k) {
    case 'compound': { const o = {}; for (const [k, v] of node.entries) o[k] = toJs(v); return o; }
    case 'list': return node.items.map(toJs);
    case 'array': return [...node.items];
    case 'string':
    case 'num':
    case 'bool': return node.v;
    default: return null;
  }
}

/* ----------------------------- Helpers ----------------------------- */

export function makeId() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function get(node, key) { return isCompound(node) ? node.entries.get(key) : undefined; }
function set(node, key, val) { node.entries.set(key, val); }
function asString(node) {
  if (!node) return null;
  if (node.k === 'string') return node.v;
  if (node.k === 'num') return String(node.v);
  if (node.k === 'bool') return node.v ? 'true' : 'false';
  return null;
}
function asNumber(node) {
  if (!node) return null;
  if (node.k === 'num') return node.v;
  if (node.k === 'string' && /^[-+]?[0-9.]+$/.test(node.v)) return Number(node.v);
  if (node.k === 'bool') return node.v ? 1 : 0;
  return null;
}

/** Force a node to a typed number (used for coordinates / counts). */
function toNum(node, kind, fallback = 0) {
  const v = asNumber(node);
  return n.num(v === null || Number.isNaN(v) ? fallback : v, kind);
}

/* --------------------- FTB Quests chapter validator ------------------ */

// Registry names verified against FTB-Quests 1.20.1 source (TaskTypes.java,
// KillTask.java): item, checkmark, kill, stat, advancement, location, structure,
// fluid. There is no "entity" or "recipe" task — accepting those would let a
// file through that the mod then fails to load.
const TASK_TYPES = new Set(['item', 'checkmark', 'kill', 'stat', 'advancement', 'location', 'structure', 'fluid']);
const REWARD_TYPES = new Set(['item', 'xp', 'command', 'choice', 'random', 'loot']);
// Frame shapes confirmed in real 1.20.1 chapter files. Anything else is
// dropped (quest falls back to the chapter default frame) rather than risk
// an unknown enum value choking the FTB Quests loader.
const QUEST_SHAPES = new Set(['square', 'hex']);

/**
 * Validate + repair one parsed chapter AST in place so it conforms to the
 * FTB Quests (MC 1.20.1) structure. Guarantees:
 *  - chapter has id (16 hex), title, filename == file stem, order_index
 *  - quests is a non-empty list; every quest has unique 16-hex id, title,
 *    double x/y, sane tasks and rewards
 *  - dependency graph has no cycles and only references quests in this file
 *    (allowedIds lets legal cross-chapter gates through: FTB Quests resolves
 *    dependency ids pack-wide via BaseQuestFile, not per chapter)
 *  - no unknown task/reward types that could crash the loader
 *
 * @param {Iterable<string>} [allowedIds] extra 16-hex quest ids (other chapters')
 *        that this chapter's dependencies may legally point at.
 * @returns {{ chapter: object, warnings: string[] }}
 */
export function normalizeChapter(root, { orderIndex = 0, filename = 'chapter', warn = () => {}, knownNamespaces = null, allowedIds = null } = {}) {
  const warnings = [];
  const w = (msg) => { warnings.push(msg); warn(msg); };

  if (!isCompound(root)) throw new Error('chapter root must be a compound { ... }');

  // --- chapter-level fields -----------------------------------------
  const title = asString(get(root, 'title'));
  if (!title || !title.trim()) { set(root, 'title', n.str(`Chapter ${orderIndex + 1}`)); w('chapter missing title; filled default'); }

  let id = asString(get(root, 'id'));
  if (!id || !HEX_ID.test(id)) { set(root, 'id', n.str(makeId())); w('chapter had missing/invalid id; generated new 16-hex id'); }
  id = asString(get(root, 'id'));

  set(root, 'filename', n.str(filename));
  set(root, 'order_index', n.num(orderIndex, 'int'));
  if (!isList(get(root, 'quest_links'))) set(root, 'quest_links', n.list([]));
  if (get(root, 'default_hide_dependency_lines') === undefined) set(root, 'default_hide_dependency_lines', n.bool(false));
  if (get(root, 'default_quest_shape') === undefined) set(root, 'default_quest_shape', n.str(''));

  // --- quests ---------------------------------------------------------
  let quests = get(root, 'quests');
  if (!isList(quests)) {
    if (quests === undefined) throw new Error(`chapter "${asString(get(root, 'title'))}" has no quests list`);
    quests = n.list([]);
    set(root, 'quests', quests);
  }
  if (quests.items.length === 0) throw new Error(`chapter "${asString(get(root, 'title'))}" contains zero quests`);

  const seenIds = new Set([id]);
  const questIds = [];
  const warnFn = w;

  quests.items = quests.items.filter((q) => {
    if (!isCompound(q)) { w('dropped a non-compound quest entry'); return false; }
    return true;
  });
  if (quests.items.length === 0) throw new Error('chapter has no valid quests after repair');

  quests.items.forEach((q, qi) => {
    // id
    let qid = asString(get(q, 'id'));
    if (!qid || !HEX_ID.test(qid) || seenIds.has(qid.toUpperCase())) {
      do { qid = makeId(); } while (seenIds.has(qid));
      set(q, 'id', n.str(qid));
      w(`quest #${qi + 1}: assigned missing/duplicate id`);
    }
    seenIds.add(qid.toUpperCase());
    questIds.push(qid.toUpperCase());

    // title
    const qt = asString(get(q, 'title'));
    if (!qt || !qt.trim()) { set(q, 'title', n.str(`Quest ${qi + 1}`)); w(`quest #${qi + 1}: missing title; filled default`); }

    // coordinates must be doubles (x: 0.0d / y: 1.5d)
    const gx = get(q, 'x'), gy = get(q, 'y');
    if (gx === undefined || asNumber(gx) === null) {
      set(q, 'x', n.d((qi % 4) * 2));
      w(`quest #${qi + 1}: missing x; placed on grid`);
    }
    if (gy === undefined || asNumber(gy) === null) {
      set(q, 'y', n.d(Math.floor(qi / 4) * 2));
      w(`quest #${qi + 1}: missing y; placed on grid`);
    }
    const qx = get(q, 'x'), qy = get(q, 'y');
    if (qx.k !== 'double') { set(q, 'x', toNum(qx, 'double')); w(`quest #${qi + 1}: coerced x to double (x: 0.0d)`); }
    if (qy.k !== 'double') { set(q, 'y', toNum(qy, 'double')); w(`quest #${qi + 1}: coerced y to double (y: 0.0d)`); }

    // subtitle / description must be string or list of strings
    const desc = get(q, 'description');
    if (desc !== undefined) {
      const ok = desc.k === 'string' || (desc.k === 'list' && desc.items.every((it) => it.k === 'string'));
      if (!ok) {
        const s = desc.k === 'list' ? desc.items.map((it) => asString(it)).filter(Boolean).join('\n') : asString(desc);
        if (s) set(q, 'description', n.str(s)); else q.entries.delete('description');
        w(`quest #${qi + 1}: normalized malformed description`);
      }
    }
    const icon = get(q, 'icon');
    if (icon !== undefined && (!asString(icon) || !ITEM_ID.test(asString(icon)))) {
      q.entries.delete('icon');
      w(`quest #${qi + 1}: dropped invalid icon id`);
    } else if (icon !== undefined && knownNamespaces) {
      const ns = asString(icon).split(':')[0];
      if (!knownNamespaces.has(ns)) {
        w(`quest #${qi + 1}: icon "${asString(icon)}" uses namespace "${ns}" that may not be installed (shows as missing texture)`);
      }
    }

    // --- tasks --------------------------------------------------------
    let tasks = get(q, 'tasks');
    if (!isList(tasks)) { tasks = n.list([]); set(q, 'tasks', tasks); }
    tasks.items = tasks.items.filter((t) => {
      if (!isCompound(t)) { w(`quest #${qi + 1}: dropped malformed task`); return false; }
      return true;
    });
    if (tasks.items.length === 0) {
      tasks.items.push(n.compound({ id: n.str(makeId()), title: n.str('Confirm'), type: n.str('checkmark') }));
      w(`quest #${qi + 1}: had no valid task; injected checkmark task`);
    }
    for (const t of tasks.items) {
      let tid = asString(get(t, 'id'));
      if (!tid || !HEX_ID.test(tid) || seenIds.has(tid.toUpperCase())) {
        do { tid = makeId(); } while (seenIds.has(tid));
        set(t, 'id', n.str(tid));
      }
      seenIds.add(tid.toUpperCase());

      let type = asString(get(t, 'type'));
      if (!type || !TASK_TYPES.has(type)) {
        set(t, 'type', n.str('checkmark'));
        // strip config that belonged to the rejected type
        if (type) w(`quest #${qi + 1}: unknown task type "${type}" -> replaced with checkmark`);
        else w(`quest #${qi + 1}: task missing type -> replaced with checkmark`);
        t.entries.delete('item'); t.entries.delete('count'); t.entries.delete('nbt'); t.entries.delete('value');
        t.entries.delete('entity');
        type = 'checkmark';
      }
      if (type === 'kill') {
        // KillTask.writeData: entity id string + long count under "value"
        const entity = asString(get(t, 'entity'));
        if (!entity || !ITEM_ID.test(entity)) {
          set(t, 'type', n.str('checkmark'));
          t.entries.delete('entity'); t.entries.delete('value'); t.entries.delete('count');
          w(`quest #${qi + 1}: kill task with invalid entity "${entity ?? '<missing>'}" -> converted to checkmark`);
        } else {
          if (knownNamespaces) {
            const ns = entity.split(':')[0];
            if (!knownNamespaces.has(ns)) {
              w(`quest #${qi + 1}: kill task entity "${entity}" uses namespace "${ns}" that may not be installed (task may be uncompletable)`);
            }
          }
          const rawV = get(t, 'value') !== undefined ? get(t, 'value') : get(t, 'count');
          let cv = asNumber(rawV);
          if (cv === null || !Number.isFinite(cv) || cv < 1) { cv = 1; w(`quest #${qi + 1}: bad kill count -> 1L`); }
          t.entries.delete('count');
          set(t, 'value', n.l(cv));
        }
      }
      if (type === 'item') {
        let item = get(t, 'item');
        let itemId = null;
        if (item && item.k === 'compound') {
          // legacy stack form { id: "...", Count: ... } — flatten to plain id string
          itemId = asString(get(item, 'id'));
          if (itemId) { set(t, 'item', n.str(itemId)); item = get(t, 'item'); }
        }
        itemId = asString(item);
        if (!itemId || !ITEM_ID.test(itemId)) {
          set(t, 'type', n.str('checkmark'));
          t.entries.delete('item'); t.entries.delete('count'); t.entries.delete('nbt');
          w(`quest #${qi + 1}: invalid item id "${itemId ?? '<missing>'}" -> task converted to checkmark`);
        } else {
          if (knownNamespaces) {
            const ns = itemId.split(':')[0];
            if (!knownNamespaces.has(ns)) {
              w(`quest #${qi + 1}: task item "${itemId}" uses namespace "${ns}" that may not be installed (task may be uncompletable)`);
            }
          }
          const count = get(t, 'count');
          if (count === undefined) set(t, 'count', n.l(1));
          else {
            const cv = asNumber(count);
            if (cv === null || !Number.isFinite(cv) || cv < 1) { set(t, 'count', n.l(1)); w(`quest #${qi + 1}: bad task count -> 1L`); }
            else if (count.k !== 'long') set(t, 'count', n.l(cv));
          }
        }
      }
    }

    // --- rewards ------------------------------------------------------
    let rewards = get(q, 'rewards');
    if (rewards !== undefined) {
      if (!isList(rewards)) { q.entries.delete('rewards'); w(`quest #${qi + 1}: rewards was not a list; dropped`); }
      else {
        const kept = [];
        for (const r of rewards.items) {
          if (!isCompound(r)) { w(`quest #${qi + 1}: dropped malformed reward`); continue; }
          let rid = asString(get(r, 'id'));
          if (!rid || !HEX_ID.test(rid) || seenIds.has(rid.toUpperCase())) {
            do { rid = makeId(); } while (seenIds.has(rid));
            set(r, 'id', n.str(rid));
          }
          seenIds.add(rid.toUpperCase());

          const rtype = asString(get(r, 'type'));
          if (!rtype || !REWARD_TYPES.has(rtype)) {
            w(`quest #${qi + 1}: unknown reward type "${rtype ?? '<missing>'}" -> reward dropped`);
            continue;
          }
          if (rtype === 'item') {
            const itemId = asString(get(r, 'item'));
            if (!itemId || !ITEM_ID.test(itemId)) {
              w(`quest #${qi + 1}: reward has invalid item "${itemId ?? '<missing>'}" -> dropped`);
              continue;
            }
            if (knownNamespaces) {
              const ns = itemId.split(':')[0];
              if (!knownNamespaces.has(ns)) {
                w(`quest #${qi + 1}: reward item "${itemId}" uses namespace "${ns}" that may not be installed`);
              }
            }
            const c = get(r, 'count');
            if (c !== undefined) {
              const cv = asNumber(c);
              set(r, 'count', n.i(cv === null || cv < 1 ? 1 : cv));
            }
          } else if (rtype === 'xp') {
            const xv = asNumber(get(r, 'xp'));
            if (xv === null || xv < 0) { w(`quest #${qi + 1}: bad xp reward -> dropped`); continue; }
            set(r, 'xp', n.i(xv));
          } else if (rtype === 'command') {
            const cmd = asString(get(r, 'command'));
            if (!cmd) { w(`quest #${qi + 1}: command reward without command -> dropped`); continue; }
            set(r, 'command', n.str(cmd));
          } else {
            // choice/random/loot require an existing reward table id (long)
            const tbl = get(r, 'table_id');
            const tv = tbl ? asNumber(tbl) : null;
            if (tv === null) { w(`quest #${qi + 1}: ${rtype} reward without table_id -> dropped`); continue; }
            set(r, 'table_id', n.l(tv));
          }
          kept.push(r);
        }
        if (kept.length === 0) q.entries.delete('rewards');
        else set(q, 'rewards', n.list(kept));
      }
    }

    // frame shape: only values FTB Quests actually defines (display-only field,
    // but an unknown enum string is a load risk — drop unknowns)
    const shape = get(q, 'shape');
    if (shape !== undefined) {
      const sv = asString(shape);
      if (!sv || !QUEST_SHAPES.has(sv.toLowerCase())) {
        q.entries.delete('shape');
        w(`quest #${qi + 1}: unknown shape "${sv ?? ''}" -> using chapter default (valid: ${[...QUEST_SHAPES].join(', ')})`);
      }
    }
  });

  // --- dependencies: keep only refs to this file's quests + allowed ids --
  const idSet = new Set(questIds);
  if (allowedIds) for (const x of allowedIds) idSet.add(String(x).toUpperCase());
  quests.items.forEach((q, qi) => {
    const deps = get(q, 'dependencies');
    if (deps === undefined) return;
    if (!isList(deps)) { q.entries.delete('dependencies'); w(`quest #${qi + 1}: dependencies not a list; dropped`); return; }
    const qid = asString(get(q, 'id')).toUpperCase();
    const cleaned = [];
    for (const d of deps.items) {
      const s = asString(d);
      if (!s) { w(`quest #${qi + 1}: dropped non-string dependency`); continue; }
      const u = s.toUpperCase();
      if (!HEX_ID.test(u)) { w(`quest #${qi + 1}: dropped malformed dependency id "${s}"`); continue; }
      if (u === qid) { w(`quest #${qi + 1}: dropped self-dependency`); continue; }
      if (!idSet.has(u)) { w(`quest #${qi + 1}: dropped dependency on foreign quest ${u}`); continue; }
      if (!cleaned.includes(u)) cleaned.push(u);
    }
    set(q, 'dependencies', n.list(cleaned.map((s) => n.str(s))));
  });

  // cycle removal (an accidental cycle makes quests permanently uncompletable)
  const depMap = new Map();
  quests.items.forEach((q) => {
    depMap.set(asString(get(q, 'id')).toUpperCase(), (get(q, 'dependencies')?.items ?? []).map((d) => d.v.toUpperCase()));
  });
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map([...depMap.keys()].map((k) => [k, WHITE]));
  const breakCycle = (node, stack) => {
    color.set(node, GREY);
    for (const dep of [...(depMap.get(node) ?? [])]) {
      if (color.get(dep) === GREY) {
        // back edge node -> dep closes a cycle: remove it
        const qNode = quests.items.find((q) => asString(get(q, 'id')).toUpperCase() === node);
        const dl = get(qNode, 'dependencies');
        dl.items = dl.items.filter((d) => d.v.toUpperCase() !== dep);
        depMap.set(node, depMap.get(node).filter((d) => d !== dep));
        w(`broke dependency cycle: removed ${node} -> ${dep}`);
      } else if (color.get(dep) === WHITE && depMap.has(dep)) {
        breakCycle(dep, stack);
      }
    }
    color.set(node, BLACK);
  };
  for (const k of depMap.keys()) if (color.get(k) === WHITE) breakCycle(k, []);

  /* --------- dependency-aware layout repair (visual progression) --------- */
  // FTB Quests draws dependency lines from a quest to the quests it needs.
  // Rule: a quest must sit strictly to the RIGHT of everything it depends on
  // (x_dep + 2 minimum), otherwise the progression reads backwards in-game.
  const idOf = (q) => asString(get(q, 'id')).toUpperCase();
  const byId = new Map(quests.items.map((q) => [idOf(q), q]));

  // topological order (dependencies first) over the now-acyclic graph
  const indeg = new Map();
  const dependents = new Map();
  for (const [qid, q] of byId) {
    const deps = (get(q, 'dependencies')?.items ?? [])
      .map((d) => d.v.toUpperCase()).filter((d) => byId.has(d));
    indeg.set(qid, deps.length);
    for (const d of deps) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d).push(qid);
    }
  }
  const queue = [...indeg.entries()].filter(([, v]) => v === 0).map(([k]) => k);
  const topoOrder = [];
  while (queue.length) {
    const qid = queue.shift();
    topoOrder.push(qid);
    for (const dep of dependents.get(qid) ?? []) {
      indeg.set(dep, indeg.get(dep) - 1);
      if (indeg.get(dep) === 0) queue.push(dep);
    }
  }
  // safety net: any node not emitted (shouldn't happen post-cycle-break) still gets visited
  for (const qid of byId.keys()) if (!topoOrder.includes(qid)) topoOrder.push(qid);

  for (const qid of topoOrder) {
    const q = byId.get(qid);
    const depXs = (get(q, 'dependencies')?.items ?? [])
      .map((d) => byId.get(d.v.toUpperCase()))
      .filter(Boolean)
      .map((dq) => asNumber(dq.entries.get('x')));
    const minX = depXs.length ? Math.max(...depXs) + 2 : -Infinity;
    const x = asNumber(q.entries.get('x'));
    if (x < minX) {
      const snapped = Math.ceil(minX / 2) * 2;   // stay on the even 2.0 grid
      set(q, 'x', n.d(snapped));
      w(`quest "${asString(get(q, 'title'))}": moved x ${x} -> ${snapped}.0d so it sits right of its dependencies`);
    }
  }

  // overlap repair: two quests on the same tile render on top of each other
  const coords = new Set();
  for (const q of quests.items) {
    let x = asNumber(q.entries.get('x'));
    let y = asNumber(q.entries.get('y'));
    while (coords.has(`${x},${y}`)) {
      y += 2;
      w(`quest "${asString(get(q, 'title'))}": moved down to y: ${y}.0d to avoid overlapping another quest`);
    }
    set(q, 'x', n.d(x));
    set(q, 'y', n.d(y));
    coords.add(`${x},${y}`);
  }

  return { chapter: root, warnings: warnings };
}

/**
 * Render a full chapter file: validate, then serialize canonically.
 * Throws if the chapter is unrecoverable (zero quests etc.).
 */
export function renderChapter(root, opts) {
  const { chapter, warnings } = normalizeChapter(root, opts);
  return { snbt: stringifySnbt(chapter) + '\n', warnings };
}

export { HEX_ID, ITEM_ID, TASK_TYPES, REWARD_TYPES, QUEST_SHAPES };
