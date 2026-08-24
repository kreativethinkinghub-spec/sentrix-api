import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
// Any authenticated member can add a document; deletion is restricted.
const CAN_DELETE = requireRole('admin', 'director', 'pm');

// List documents for a project
router.get('/:projectId', async (req, res) => {
  try {
    const rows = await query(
      `SELECT d.*, u.full_name AS uploaded_name
       FROM documents d LEFT JOIN users u ON d.uploaded_by = u.id
       WHERE d.project_id = $1 ORDER BY d.created_at DESC`,
      [req.params.projectId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Register a document (metadata + file_url from storage; upload handled client-side)
router.post('/', async (req, res) => {
  try {
    const { project_id, name, file_url, file_size, mime_type, category } = req.body;
    if (!project_id || !name) return res.status(400).json({ error: 'project_id and name are required' });

    const row = await queryOne(
      `INSERT INTO documents (project_id, name, file_url, file_size, mime_type, category, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [project_id, name, file_url, file_size, mime_type, category || 'general', req.user.id]
    );

    await queryOne(
      `INSERT INTO audit_log (org_id, project_id, user_id, action, entity_type, entity_id, details)
       VALUES ($1,$2,$3,'document.added','document',$4,$5)`,
      [req.user.org_id, project_id, req.user.id, row.id, JSON.stringify({ name, category: category || 'general' })]
    );

    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', CAN_DELETE, async (req, res) => {
  try {
    await queryOne('DELETE FROM documents WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
