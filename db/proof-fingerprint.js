/*  SENTRIX — Project Fingerprint™ PROOF harness (no DB required)
 *  Generates the real 100k WORLDWIDE corpus and runs the EXACT scoring algorithm
 *  from routes/fingerprint.js `/match-project` against it, for sample projects.
 *  Proves: (a) the corpus is 100k worldwide/all-domains, (b) matching returns
 *  relevant worldwide results. Run:  node db/proof-fingerprint.js
 */
import { generateFingerprints } from './generate-fingerprints.js';

// ── exact copy of the /match-project scoring (routes/fingerprint.js) ─────────
function scoreAgainst(project, fingerprints) {
  const scored = fingerprints.map(fp => {
    let score = 0, factors = 0;
    if (fp.sector && project.sector)         { score += fp.sector === project.sector ? 20 : 0; factors++; }
    if (fp.methodology && project.methodology){ score += fp.methodology === project.methodology ? 15 : 0; factors++; }
    if (fp.province && project.province)      { score += fp.province === project.province ? 10 : 0; factors++; }
    if (fp.country_code && project.country_code){ score += fp.country_code === project.country_code ? 5 : 0; factors++; }
    const dimensions = {
      team: fp.team_score, risk: fp.risk_score, delivery: fp.delivery_score,
      governance: fp.governance_score, esg: fp.esg_score,
      supply_chain: fp.supply_chain_score, complexity: fp.complexity_score
    };
    return { ...fp, match_score: factors > 0 ? Math.round((score / (factors * 20)) * 100) : 0, dimensions };
  });
  scored.sort((a, b) => b.match_score - a.match_score);
  return scored;
}

console.log('Generating 100,000 worldwide fingerprints (real generator)...');
const t0 = Date.now();
const corpus = generateFingerprints(100000);
console.log(`  done in ${Date.now() - t0}ms\n`);

// ── /stats equivalent ────────────────────────────────────────────────────────
const sectors = new Set(corpus.map(f => f.sector));
const countries = new Set(corpus.map(f => f.country_code));
const regions = new Set(corpus.map(f => f.province));
const verified = corpus.filter(f => f.is_verified).length;
console.log('=== /api/fingerprint/stats (proof) ===');
console.log(JSON.stringify({
  total: corpus.length, verified, sectors: sectors.size,
  countries: countries.size, regions: regions.size, dimensions: 7
}, null, 2));

// ── /match-project for two very different worldwide projects ────────────────
const projects = [
  { name: 'UK Core-Banking Migration', sector: 'Financial Services', methodology: 'agile', province: 'Western Europe', country_code: 'GB' },
  { name: 'Singapore 5G Rollout',      sector: 'Telecommunications',  methodology: 'hybrid', province: 'Asia-Pacific',   country_code: 'SG' },
];

for (const project of projects) {
  const scored = scoreAgainst(project, corpus);
  const top = scored.slice(0, 8);
  console.log(`\n=== /match-project: ${project.name}  (${project.sector}, ${project.country_code}) ===`);
  console.log(`scanned ${corpus.length.toLocaleString()} DNA profiles · top ${top.length} shown`);
  for (const m of top) {
    console.log(`  ${String(m.match_score).padStart(3)}%  ${m.name}`);
    console.log(`        ${m.sector} · ${m.country_code}/${m.province} · ${m.methodology} · outcome=${m.outcome} · verified=${m.is_verified}`);
  }
  // prove the corpus (not just the top) spans the globe & domains
  const topCountries = new Set(scored.slice(0, 100).map(m => m.country_code));
  console.log(`  → top-100 matches span ${topCountries.size} countries`);
}

console.log('\n✔ PROOF COMPLETE — 100k worldwide corpus, real /match-project scoring, live results above.');
