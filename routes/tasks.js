import { Router } from 'express';
import { supabase } from '../db/client.js';

const router = Router();

router.get('/:projectId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tasks')
      .select('*, assigned:users!tasks_assigned_to_fkey(id, full_name, email)')
      .eq('project_id', req.params.projectId)
      .order('sort_order');

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { project_id, title, description, status, priority, assigned_to, due_date } = req.body;

    if (!project_id || !title) {
      return res.status(400).json({ error: 'project_id and title are required' });
    }

    const { data, error } = await supabase
      .from('tasks')
      .insert({
        project_id, title, description,
        status: status || 'todo',
        priority: priority || 'medium',
        assigned_to, due_date,
        created_by: req.user.id
      })
      .select()
      .single();

    if (error) throw error;

    if (assigned_to) {
      await supabase.from('notifications').insert({
        user_id: assigned_to,
        project_id,
        type: 'task',
        title: 'New task assigned',
        body: title,
        action_url: `/dashboard?project=${project_id}&view=tasks`
      });
    }

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['title', 'description', 'status', 'priority', 'assigned_to', 'due_date', 'sort_order'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (updates.status === 'done') {
      updates.completed_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
