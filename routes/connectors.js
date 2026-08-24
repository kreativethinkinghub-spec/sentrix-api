import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireOrgAdmin } from '../middleware/auth.js';

const router = Router();

const PROVIDERS = ['jira','azure-devops','ms-project','sap','power-bi','primavera','sharepoint','teams','custom'];

// List the org's connectors (tokens never returned)
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, org_id, provider, config, is_active, last_sync_at, created_at,
              (access_token_encrypted IS NOT NULL) AS is_authorised
       FROM connectors WHERE org_id = $1 ORDER BY created_at DESC`,
      [req.user.org_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create / configure a connector (org admin only). OAuth token exchange is a
// later phase — this stores provider + config and marks it active.
router.post('/', requireOrgAdmin, async (req, res) => {
  try {
    const { provider, config } = req.body;
    if (!PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `provider must be one of: ${PROVIDERS.join(', ')}` });
    }
    const row = await queryOne(
      `INSERT INTO connectors (org_id, provider, config, is_active)
       VALUES ($1,$2,$3,TRUE)
       RETURNING id, org_id, provider, config, is_active, last_sync_at, created_at`,
      [req.user.org_id, provider, config ? JSON.stringify(config) : null]
    );
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', requireOrgAdmin, async (req, res) => {
  try {
    const allowed = ['config','is_active'];
    const sets = [];
    const vals = [];
    let i = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        sets.push(`${key} = $${i++}`);
        vals.push(key === 'config' ? JSON.stringify(req.body[key]) : req.body[key]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    vals.push(req.params.id, req.user.org_id);
    const row = await queryOne(
      `UPDATE connectors SET ${sets.join(', ')} WHERE id = $${i++} AND org_id = $${i}
       RETURNING id, org_id, provider, config, is_active, last_sync_at, created_at`,
      vals
    );
    if (!row) return res.status(404).json({ error: 'Connector not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireOrgAdmin, async (req, res) => {
  try {
    await queryOne('DELETE FROM connectors WHERE id = $1 AND org_id = $2', [req.params.id, req.user.org_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
