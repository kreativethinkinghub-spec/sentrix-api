// Critical Path Method — forward/backward pass over a task network.
// tasks: [{ id, duration_days }]   deps: [{ task_id (successor), depends_on_task_id (predecessor) }]
export function computeCPM(tasks, deps) {
  const dur = {}, preds = {}, succs = {};
  tasks.forEach(t => { dur[t.id] = Math.max(0, t.duration_days || 1); preds[t.id] = []; succs[t.id] = []; });
  deps.forEach(d => {
    if (preds[d.task_id] && succs[d.depends_on_task_id]) {
      preds[d.task_id].push(d.depends_on_task_id);
      succs[d.depends_on_task_id].push(d.task_id);
    }
  });

  // Topological order (Kahn) — detects cycles.
  const indeg = {}; tasks.forEach(t => { indeg[t.id] = preds[t.id].length; });
  const q = tasks.filter(t => indeg[t.id] === 0).map(t => t.id);
  const order = [];
  while (q.length) { const n = q.shift(); order.push(n); succs[n].forEach(s => { if (--indeg[s] === 0) q.push(s); }); }
  if (order.length !== tasks.length) return { error: 'Cycle detected in task dependencies' };

  const ES = {}, EF = {};
  order.forEach(n => { ES[n] = preds[n].length ? Math.max(...preds[n].map(p => EF[p])) : 0; EF[n] = ES[n] + dur[n]; });
  const projEnd = Math.max(0, ...tasks.map(t => EF[t.id]));

  const LS = {}, LF = {};
  [...order].reverse().forEach(n => { LF[n] = succs[n].length ? Math.min(...succs[n].map(s => LS[s])) : projEnd; LS[n] = LF[n] - dur[n]; });

  const rows = tasks.map(t => ({
    id: t.id, es: ES[t.id], ef: EF[t.id], ls: LS[t.id], lf: LF[t.id],
    slack: LS[t.id] - ES[t.id], critical: LS[t.id] - ES[t.id] === 0,
  }));
  return { project_duration_days: projEnd, critical_path: order.filter(n => LS[n] - ES[n] === 0), tasks: rows };
}
