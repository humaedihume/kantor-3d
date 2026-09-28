// Port Node dari src/State.php — JSON /kerja/api/state dan konfigurasi halaman.
import path from 'node:path';
import { Discovery, team as readTeam } from './discovery.mjs';
import { buildFallback } from './fallback.mjs';
import { Planning } from './planning.mjs';
import { Transcripts } from './transcripts.mjs';
import { isoC, nowSec, phpTrim, readText, strcmp } from './util.mjs';

export function loadRules(kerjaDir) {
  const r = JSON.parse(readText(path.join(kerjaDir, 'src', 'rules.json')) ?? 'null');
  if (!r || typeof r !== 'object') throw new Error('src/rules.json tidak valid');
  return r;
}

export function discover(project, kerjaDir, config) {
  const rules = loadRules(kerjaDir);
  const disc = new Discovery(project, config, rules);
  const scan = new Transcripts(project, kerjaDir, disc.resolve, Number(rules.window_days)).scan();
  const team = readTeam(project);
  const sel = disc.select(scan.runs, team);
  return { roles: sel.roles, overflow: sel.overflow, runs: scan.runs, mains: scan.mains, team };
}

const publicRole = (r) => ({ key: r.key, name: r.name, role: r.role, color: r.color, look: r.look, screen: r.screen, asks: r.asks, source: r.source });
const layout = (roles) => roles.map((r) => `${r.key}:${r.name}:${r.color}`).join(',');

export function pageConfig(config, d) {
  return { project: config.project, roles: d.roles.map(publicRole), orchestrator: config.orchestrator, team: d.team, layout: layout(d.roles) };
}

const tok = (r) => r.tokens.in + r.tokens.out + r.tokens.cache;

function agent(mine) {
  const latest = mine[0] ?? null;
  const active = mine.filter((r) => r.status === 'bekerja');
  const cur = active[0] ?? latest;
  return {
    state: cur?.status ?? 'siaga',
    parallel: active.length,
    task: cur?.description ?? null,
    since: cur?.started ?? null,
    updated: cur?.updated ?? null,
    last: cur ? [...cur.events].reverse().slice(0, 8) : [],
    final: (cur?.status ?? '') === 'selesai' ? (cur.final ?? null) : null,
    limit: cur?.limit ?? null,
    files: cur ? cur.files.slice(-8).map((f) => f[0]) : [],
    runs: mine.length,
    tools: mine.reduce((s, r) => s + r.tools, 0),
    tokens_out: mine.reduce((s, r) => s + r.tokens.out, 0),
    tokens_all: mine.reduce((s, r) => s + tok(r), 0),
  };
}

export async function buildState(project, kerjaDir, config) {
  const d = discover(project, kerjaDir, config);
  const runs = d.runs;
  const roleKeys = d.roles.map((r) => r.key);
  const asker = d.roles.find((r) => r.asks)?.key ?? '';
  const planning = new Planning(path.join(project, 'planning'));
  const mode = planning.exists() ? 'planning' : 'auto';
  const plan = planning.snapshot();

  const agents = {};
  for (const role of [...roleKeys, 'orkestrator']) agents[role] = agent(runs.filter((r) => r.role === role));
  const busy = roleKeys.filter((r) => agents[r].state === 'bekerja');
  const pendingQ = (plan.roadmap.questions ?? []).filter((q) => q.tag === 'BLOKIR' && !q.answered);
  if (!busy.length && pendingQ.length && agents[asker]) agents[asker].state = 'menunggu';

  const overflow = d.overflow.map((o) => {
    const a = agent(runs.filter((r) => r.role === o.key));
    return { key: o.key, name: o.name, role: o.role, color: o.color, state: a.state, task: a.task, updated: a.updated, runs: a.runs };
  });

  const feed = [];
  for (const r of runs) {
    for (const e of r.events) {
      if (r.role === 'orkestrator' && !['Agent', 'Task', 'SendMessage', 'AskUserQuestion', 'Skill', 'TaskStop'].includes(e.tool) && e.kind !== 'user') continue;
      feed.push({ ...e, role: r.role, run: r.id });
    }
  }
  feed.sort((a, b) => strcmp(b.t, a.t));

  const tunnel = phpTrim(readText(path.join(kerjaDir, 'storage', 'tunnel-url.txt')) ?? '');
  const sub = runs.filter((r) => r.role !== 'orkestrator');
  return {
    now: isoC(nowSec()),
    mode,
    layout: layout(d.roles),
    roles: d.roles.map(publicRole),
    overflow,
    team: d.team,
    agents,
    runs: sub.slice(0, 30).map((r) => ({
      id: r.id, role: r.role, description: r.description, status: r.status, started: r.started, updated: r.updated, tools: r.tools, tokens: tok(r),
    })),
    feed: feed.slice(0, 120),
    pending_questions: pendingQ,
    totals: { runs: sub.length, tools: runs.reduce((s, r) => s + r.tools, 0), tokens: runs.reduce((s, r) => s + tok(r), 0) },
    fallback: mode === 'auto' ? await buildFallback(project, runs, d.mains) : null,
    public_url: tunnel !== '' ? tunnel : config.public_url,
    ...plan,
  };
}
