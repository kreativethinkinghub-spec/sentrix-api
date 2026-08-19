import { Router } from 'express';
import { supabase } from '../db/client.js';

const router = Router();

router.get('/match', async (req, res) => {
  try {
    const { sector, province, budget_range, methodology, country_code, limit: maxResults } = req.query;

    let query = supabase.from('fingerprints').select('*');

    if (sector) query = query.eq('sector', sector);
    if (province) query = query.eq('province', province);
    if (budget_range) query = query.eq('budget_range', budget_range);
    if (methodology) query = query.eq('methodology', methodology);
    if (country_code) query = query.eq('country_code', country_code);

    query = query.limit(parseInt(maxResults) || 20);

    const { data, error } = await query;
    if (error) throw error;

    res.json({
      matches: data,
      total: data.length,
      dimensions: ['team', 'risk', 'delivery', 'governance', 'esg', 'supply_chain', 'complexity']
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/match-project', async (req, res) => {
  try {
    const { project_id } = req.body;
    if (!project_id) return res.status(400).json({ error: 'project_id is required' });

    const { data: project } = await supabase
      .from('projects')
      .select('*')
      .eq('id', project_id)
      .eq('org_id', req.user.org_id)
      .single();

    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { data: fingerprints } = await supabase
      .from('fingerprints')
      .select('*')
      .limit(100);

    if (!fingerprints?.length) {
      return res.json({ matches: [], message: 'No fingerprint data available' });
    }

    const scored = fingerprints.map(fp => {
      let score = 0;
      let factors = 0;

      if (fp.sector && project.sector) {
        score += fp.sector === project.sector ? 20 : 0;
        factors++;
      }
      if (fp.methodology && project.methodology) {
        score += fp.methodology === project.methodology ? 15 : 0;
        factors++;
      }
      if (fp.province && project.province) {
        score += fp.province === project.province ? 10 : 0;
        factors++;
      }
      if (fp.country_code && project.country_code) {
        score += fp.country_code === project.country_code ? 5 : 0;
        factors++;
      }

      const dimensions = {
        team: fp.team_score || 0,
        risk: fp.risk_score || 0,
        delivery: fp.delivery_score || 0,
        governance: fp.governance_score || 0,
        esg: fp.esg_score || 0,
        supply_chain: fp.supply_chain_score || 0,
        complexity: fp.complexity_score || 0
      };

      return {
        ...fp,
        match_score: factors > 0 ? Math.round((score / (factors * 20)) * 100) : 0,
        dimensions
      };
    });

    scored.sort((a, b) => b.match_score - a.match_score);

    res.json({
      project: { id: project.id, name: project.name },
      matches: scored.slice(0, 10),
      total_in_db: fingerprints.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const { count: total } = await supabase
      .from('fingerprints')
      .select('*', { count: 'exact', head: true });

    const { count: verified } = await supabase
      .from('fingerprints')
      .select('*', { count: 'exact', head: true })
      .eq('is_verified', true);

    const { data: sectors } = await supabase
      .from('fingerprints')
      .select('sector')
      .not('sector', 'is', null);

    const uniqueSectors = [...new Set(sectors?.map(s => s.sector) || [])];

    const { data: countries } = await supabase
      .from('fingerprints')
      .select('country_code')
      .not('country_code', 'is', null);

    const uniqueCountries = [...new Set(countries?.map(c => c.country_code) || [])];

    res.json({
      total: total || 0,
      verified: verified || 0,
      sectors: uniqueSectors.length,
      countries: uniqueCountries.length,
      dimensions: 7,
      sub_indicators: 142
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
