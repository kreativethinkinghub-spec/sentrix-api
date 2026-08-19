import { Router } from 'express';
import { supabase } from '../db/client.js';

const router = Router();

router.get('/:projectId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('risks')
      .select('*, owner:users!risks_owner_id_fkey(id, full_name)')
      .eq('project_id', req.params.projectId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { project_id, type, title, description, probability, impact, rag_status, mitigation, owner_id, target_date } = req.body;

    if (!project_id || !title) {
      return res.status(400).json({ error: 'project_id and title are required' });
    }

    const { data, error } = await supabase
      .from('risks')
      .insert({
        project_id, type: type || 'risk', title, description,
        probability, impact, rag_status: rag_status || 'amber',
        mitigation, owner_id, target_date,
        created_by: req.user.id
      })
      .select()
      .single();

    if (error) throw error;

    if (rag_status === 'red') {
      const { data: members } = await supabase
        .from('project_members')
        .select('user_id')
        .eq('project_id', project_id);

      if (members?.length) {
        await supabase.from('notifications').insert(
          members.map(m => ({
            user_id: m.user_id,
            project_id,
            type: 'risk',
            title: `Red risk raised: ${title}`,
            body: description || title,
            action_url: `/dashboard?project=${project_id}&view=risks`
          }))
        );
      }
    }

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['title', 'description', 'type', 'probability', 'impact', 'rag_status', 'mitigation', 'owner_id', 'status', 'target_date', 'resolved_date'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const { data, error } = await supabase
      .from('risks')
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

export default router;
