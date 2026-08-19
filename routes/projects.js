import { Router } from 'express';
import { supabase } from '../db/client.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('org_id', req.user.org_id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', req.params.id)
      .eq('org_id', req.user.org_id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Project not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, code, description, methodology, sector, province, budget_total, currency, start_date, target_end_date, programme_name, client_name } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required' });

    const { data, error } = await supabase
      .from('projects')
      .insert({
        org_id: req.user.org_id,
        name, code, description, methodology, sector, province,
        budget_total, currency, start_date, target_end_date,
        programme_name, client_name,
        created_by: req.user.id
      })
      .select()
      .single();

    if (error) throw error;

    await supabase.from('project_members').insert({
      project_id: data.id,
      user_id: req.user.id,
      role: 'owner'
    });

    await supabase.from('audit_log').insert({
      org_id: req.user.org_id,
      project_id: data.id,
      user_id: req.user.id,
      action: 'project.created',
      entity_type: 'project',
      entity_id: data.id,
      details: { name }
    });

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['name', 'code', 'description', 'status', 'methodology', 'sector', 'province', 'budget_total', 'budget_spent', 'currency', 'start_date', 'target_end_date', 'actual_end_date', 'programme_name', 'client_name'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const { data, error } = await supabase
      .from('projects')
      .update(updates)
      .eq('id', req.params.id)
      .eq('org_id', req.user.org_id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Project not found' });

    await supabase.from('audit_log').insert({
      org_id: req.user.org_id,
      project_id: data.id,
      user_id: req.user.id,
      action: 'project.updated',
      entity_type: 'project',
      entity_id: data.id,
      details: updates
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/dashboard', async (req, res) => {
  try {
    const pid = req.params.id;
    const org = req.user.org_id;

    const [project, tasks, risks, milestones, budget] = await Promise.all([
      supabase.from('projects').select('*').eq('id', pid).eq('org_id', org).single(),
      supabase.from('tasks').select('*').eq('project_id', pid).order('sort_order'),
      supabase.from('risks').select('*').eq('project_id', pid).order('created_at', { ascending: false }),
      supabase.from('milestones').select('*').eq('project_id', pid).order('due_date'),
      supabase.from('budget_items').select('*').eq('project_id', pid)
    ]);

    if (!project.data) return res.status(404).json({ error: 'Project not found' });

    const taskStats = {
      total: tasks.data?.length || 0,
      todo: tasks.data?.filter(t => t.status === 'todo').length || 0,
      in_progress: tasks.data?.filter(t => t.status === 'in-progress').length || 0,
      done: tasks.data?.filter(t => t.status === 'done').length || 0,
      blocked: tasks.data?.filter(t => t.status === 'blocked').length || 0
    };

    const riskStats = {
      total: risks.data?.length || 0,
      red: risks.data?.filter(r => r.rag_status === 'red').length || 0,
      amber: risks.data?.filter(r => r.rag_status === 'amber').length || 0,
      green: risks.data?.filter(r => r.rag_status === 'green').length || 0
    };

    res.json({
      project: project.data,
      tasks: tasks.data || [],
      taskStats,
      risks: risks.data || [],
      riskStats,
      milestones: milestones.data || [],
      budget: budget.data || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
