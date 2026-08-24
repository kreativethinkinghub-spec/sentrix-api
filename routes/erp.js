import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
const CAN_IMPORT = requireRole('admin', 'director', 'finance', 'pm');
const PROVIDERS = ['sap', 'primavera', 'ms-project', 'oracle', 'csv'];

// Import history for the org.
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT e.*, p.name AS project_name, u.full_name AS imported_name
       FROM erp_imports e
       LEFT JOIN projects p ON e.project_id = p.id
       LEFT JOIN users u ON e.imported_by = u.id
       WHERE e.org_id = $1 ORDER BY e.created_at DESC LIMIT 50`,
      [req.user.org_id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Generic import endpoint — the foundation a real SAP PS / Primavera connector
 * feeds into. Accepts already-extracted rows so any source (OData/BAPI export,
 * Primavera XER, MS Project, or a CSV) can post to it:
 *   kind: 'budget'   items:[{category, description, planned_amount, actual_amount, period}]
 *   kind: 'schedule' items:[{title, due_date, status, phase}]
 */
router.post('/:projectId/import', CAN_IMPORT, async (req, res) => {
  try {
    const pid = req.params.projectId;
    const { provider, kind, items } = req.body;
    if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: `provider must be one of: ${PROVIDERS.join(', ')}` });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items[] is required' });

    const project = await queryOne('SELECT id FROM projects WHERE id = $1 AND org_id = $2', [pid, req.user.org_id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let imported = 0;
    if (kind === 'budget') {
      for (const it of items) {
        if (!it.category) continue;
        await queryOne(
          `INSERT INTO budget_items (project_id, category, description, planned_amount, actual_amount, currency, period)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [pid, it.category, it.description || null, Number(it.planned_amount) || 0, Number(it.actual_amount) || 0, it.currency || 'ZAR', it.period || null]
        );
        imported++;
      }
    } else if (kind === 'schedule') {
      for (const it of items) {
        if (!it.title || !it.due_date) continue;
        await queryOne(
          `INSERT INTO milestones (project_id, title, due_date, status, phase)
           VALUES ($1,$2,$3,$4,$5)`,
          [pid, it.title, it.due_date, it.status || 'pending', it.phase || provider.toUpperCase()]
        );
        imported++;
      }
    } else {
      return res.status(400).json({ error: "kind must be 'budget' or 'schedule'" });
    }

    const log = await queryOne(
      `INSERT INTO erp_imports (org_id, project_id, provider, kind, rows_imported, summary, imported_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.org_id, pid, provider, kind, imported, JSON.stringify({ received: items.length, imported }), req.user.id]
    );
    await queryOne(
      `INSERT INTO audit_log (org_id, project_id, user_id, action, entity_type, entity_id, details)
       VALUES ($1,$2,$3,'erp.import','erp_import',$4,$5)`,
      [req.user.org_id, pid, req.user.id, log.id, JSON.stringify({ provider, kind, imported })]
    );
    res.status(201).json({ imported, of: items.length, provider, kind, log_id: log.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
