import { Router } from 'express';
import { query, queryOne } from '../db/client.js';

const router = Router();

router.get('/match', async (req, res) => {
  try {
    const { sector, province, budget_range, methodology, country_code, limit: maxResults } = req.query;

    const conditions = [];
    const vals = [];
    let i = 1;

    if (sector) { conditions.push(`sector = $${i++}`); vals.push(sector); }
    if (province) { conditions.push(`province = $${i++}`); vals.push(province); }
    if (budget_range) { conditions.push(`budget_range = $${i++}`); vals.push(budget_range); }
    if (methodology) { conditions.push(`methodology = $${i++}`); vals.push(methodology); }
    if (country_code) { conditions.push(`country_code = $${i++}`); vals.push(country_code); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    vals.push(parseInt(maxResults) || 20);

    const rows = await query(
      `SELECT * FROM fingerprints ${where} LIMIT $${i}`,
      vals
    );

    res.json({
      matches: rows,
      total: rows.length,
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

    const project = await queryOne(
      'SELECT * FROM projects WHERE id = $1 AND org_id = $2',
      [project_id, req.user.org_id]
    );
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const fingerprints = await query('SELECT * FROM fingerprints LIMIT 100');
    if (!fingerprints.length) {
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

      return { ...fp, match_score: factors > 0 ? Math.round((score / (factors * 20)) * 100) : 0, dimensions };
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
    const [totalRow, verifiedRow, sectorsRows, countriesRows] = await Promise.all([
      queryOne('SELECT COUNT(*)::int AS count FROM fingerprints'),
      queryOne('SELECT COUNT(*)::int AS count FROM fingerprints WHERE is_verified = true'),
      query('SELECT DISTINCT sector FROM fingerprints WHERE sector IS NOT NULL'),
      query('SELECT DISTINCT country_code FROM fingerprints WHERE country_code IS NOT NULL')
    ]);

    res.json({
      total: totalRow?.count || 0,
      verified: verifiedRow?.count || 0,
      sectors: sectorsRows.length,
      countries: countriesRows.length,
      dimensions: 7,
      sub_indicators: 142
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
