/*  SENTRIX — seed the Project Fingerprint™ corpus into the DB.
 *  Usage:  DATABASE_URL="postgres://..." node db/seed-fingerprints.js [count]
 *  Idempotent: skips if the table already holds >= target rows.
 */
import { pool, query, queryOne } from './client.js';
import { generateFingerprints } from './generate-fingerprints.js';

const TARGET = parseInt(process.argv[2]) || 100000;
const BATCH = 500;                       // 500 rows × 24 cols = 12 000 params (< 65 535)

const COLS = [
  'name','sector','sub_sector','province','country_code','budget_range','duration_months',
  'team_size','methodology','complexity_score','risk_score','delivery_score','governance_score',
  'esg_score','supply_chain_score','team_score','outcome','lessons_learned',
  'compliance_frameworks','tech_stack','contractors','source','is_verified','dimensions'
];

function rowValues(fp) {
  return [
    fp.name, fp.sector, fp.sub_sector, fp.province, fp.country_code, fp.budget_range,
    fp.duration_months, fp.team_size, fp.methodology, fp.complexity_score, fp.risk_score,
    fp.delivery_score, fp.governance_score, fp.esg_score, fp.supply_chain_score, fp.team_score,
    fp.outcome, fp.lessons_learned, fp.compliance_frameworks, fp.tech_stack, fp.contractors,
    fp.source, fp.is_verified, JSON.stringify(fp.dimensions)
  ];
}

// Build a multi-row INSERT with $1..$n placeholders; cast the last col to jsonb.
function buildInsert(batch) {
  const n = COLS.length;
  const params = [];
  const tuples = batch.map((fp, b) => {
    const vals = rowValues(fp);
    const ph = vals.map((_, c) => {
      const idx = b * n + c + 1;
      return c === n - 1 ? `$${idx}::jsonb` : `$${idx}`;
    });
    params.push(...vals);
    return `(${ph.join(',')})`;
  });
  const sql = `INSERT INTO fingerprints (${COLS.join(',')}) VALUES ${tuples.join(',')}`;
  return { sql, params };
}

(async () => {
  const existing = await queryOne('SELECT COUNT(*)::int AS c FROM fingerprints');
  if (existing && existing.c >= TARGET) {
    console.log(`fingerprints already holds ${existing.c} rows (>= ${TARGET}) — skipping.`);
    await pool.end();
    return;
  }
  const need = TARGET - (existing?.c || 0);
  console.log(`Seeding ${need} fingerprints (target ${TARGET}, existing ${existing?.c || 0})...`);

  const recs = generateFingerprints(need);
  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (let i = 0; i < recs.length; i += BATCH) {
      const batch = recs.slice(i, i + BATCH);
      const { sql, params } = buildInsert(batch);
      await client.query(sql, params);
      inserted += batch.length;
      if (inserted % 10000 === 0 || inserted === recs.length) {
        process.stdout.write(`\r  inserted ${inserted}/${recs.length}   `);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\nSeed failed, rolled back:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }

  const total = await queryOne('SELECT COUNT(*)::int AS c FROM fingerprints');
  const verified = await queryOne('SELECT COUNT(*)::int AS c FROM fingerprints WHERE is_verified = true');
  console.log(`\nDone. fingerprints total: ${total?.c}  (verified: ${verified?.c})`);
  await pool.end();
})();
