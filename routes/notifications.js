import { Router } from 'express';
import { query, queryOne } from '../db/client.js';

const router = Router();

// Current user's notifications (newest first). ?unread=1 for unread only.
router.get('/', async (req, res) => {
  try {
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    const rows = await query(
      `SELECT * FROM notifications
       WHERE user_id = $1 ${unreadOnly ? 'AND is_read = FALSE' : ''}
       ORDER BY created_at DESC LIMIT 100`,
      [req.user.id]
    );
    const unread = rows.filter(n => !n.is_read).length;
    res.json({ notifications: rows, unread });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark one as read
router.patch('/:id/read', async (req, res) => {
  try {
    const row = await queryOne(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.id]
    );
    if (!row) return res.status(404).json({ error: 'Notification not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark all read
router.post('/read-all', async (req, res) => {
  try {
    await query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE', [req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await queryOne('DELETE FROM notifications WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
