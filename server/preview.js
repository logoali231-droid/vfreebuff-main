// Quest-tree preview: reads the chapter .snbt files back out of the instance
// and converts them to layout JSON so the GUI can render what FTB Quests will
// draw (quests at x/y grid units, dependency lines between frame centres,
// tasks/rewards as small attached icons, description on click).
import fs from 'node:fs';
import path from 'node:path';
import { parseSnbt, toJs } from './snbt.js';

export function chaptersDirFor(instanceDir) {
  return path.join(instanceDir, 'config', 'ftbquests', 'quests', 'chapters');
}

/** Read every chapter of an instance's FTB Quests config into layout data. */
export function readChaptersLayout(instanceDir) {
  if (!instanceDir) return { instanceDir: null, chapters: [] };
  const dir = chaptersDirFor(instanceDir);
  if (!fs.existsSync(dir)) return { instanceDir, chaptersDir: dir, chapters: [] };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.snbt')).sort();
  const chapters = [];
  for (const f of files) {
    try {
      const raw = toJs(parseSnbt(fs.readFileSync(path.join(dir, f), 'utf8')));
      const quests = (Array.isArray(raw.quests) ? raw.quests : []).map((q) => ({
        id: String(q.id ?? ''),
        title: String(q.title ?? ''),
        subtitle: String(q.subtitle ?? ''),
        icon: String(q.icon ?? ''),
        x: Number(q.x) || 0,
        y: Number(q.y) || 0,
        size: Math.min(2, Math.max(0.5, Number(q.size) || 1)),
        shape: QUEST_SHAPES_LIST.includes(String(q.shape ?? '')) ? String(q.shape) : '',
        description: Array.isArray(q.description) ? q.description.join('\n') : String(q.description ?? ''),
        dependencies: (Array.isArray(q.dependencies) ? q.dependencies : []).filter((d) => typeof d === 'string'),
        tasks: (Array.isArray(q.tasks) ? q.tasks : []).map((t) => ({
          type: String(t.type ?? '?'),
          title: String(t.title ?? ''),
          item: String(t.item ?? ''),
          count: Number.isFinite(Number(t.count)) ? Number(t.count) : 1,
        })),
        rewards: (Array.isArray(q.rewards) ? q.rewards : []).map((r) => ({
          type: String(r.type ?? '?'),
          item: String(r.item ?? ''),
          count: Number.isFinite(Number(r.count)) ? Number(r.count) : 1,
          xp: Number(r.xp) || 0,
          command: String(r.command ?? ''),
        })),
      }));
      chapters.push({
        file: f,
        title: String(raw.title ?? f.replace(/\.snbt$/, '')),
        icon: String(raw.icon ?? ''),
        orderIndex: Number(raw.order_index) || 0,
        quests,
      });
    } catch (err) {
      chapters.push({ file: f, title: f, orderIndex: 999, quests: [], error: err.message });
    }
  }
  chapters.sort((a, b) => a.orderIndex - b.orderIndex);
  return { instanceDir, chaptersDir: dir, chapters };
}

// Mirrors server/snbt.js whitelist (kept local to avoid a circular import of validators).
const QUEST_SHAPES_LIST = ['square', 'hex'];
