// Feature-vector representation for Project Fingerprint matching.
// Turns a project/fingerprint into a numeric vector so we can do real
// vector recall + cosine re-rank (no external embedding API required).

const SECTORS = [
  'Software & Digital','Financial Services','Insurance','Pharmaceutical & Life Sci','Healthcare',
  'Aerospace & Defence','Space & Satellite','Automotive','Energy & Utilities','Renewable Energy',
  'Oil & Gas','Telecommunications','Media & Entertainment','Retail & E-commerce','Consumer Goods (FMCG)',
  'Manufacturing','Construction & Infra','Construction & Infrastructure','Mining & Metals','Chemicals',
  'Transportation & Logistics','Real Estate','Hospitality & Tourism','Agriculture & Agritech','Education',
  'Government & Public Sector','Non-profit & Development','Professional Services','Marketing & Advertising','Biotechnology',
  'Water & Sanitation','Transport & Roads','ICT & Telecoms','Public Infrastructure','Commercial Property','Agriculture'
];
const REGIONS = ['North America','Western Europe','Eastern Europe','Asia-Pacific','South Asia','Middle East','Sub-Saharan Africa','North Africa','Latin America','International'];
const METHODS = ['agile','scrum','kanban','waterfall','hybrid','prince2','pmbok','safe','lean','six-sigma','stage-gate','devops'];
const BUDGETS = ['<$1M','$1M–$10M','$10M–$50M','$50M–$250M','$250M–$1bn','$1bn–$5bn','>$5bn'];

const oneHot = (val, list) => list.map(x => (x === val ? 1 : 0));

// Weight categorical blocks so sector dominates, then methodology, then region/budget.
const W = { sector: 1.6, method: 1.1, region: 0.9, budget: 0.7, num: 0.6 };
const scale = (arr, w) => arr.map(v => v * w);

export function vectorOf({ sector, region, methodology, budget_range, duration_months, team_size }) {
  return [
    ...scale(oneHot(sector, SECTORS), W.sector),
    ...scale(oneHot(methodology, METHODS), W.method),
    ...scale(oneHot(region, REGIONS), W.region),
    ...scale(oneHot(budget_range, BUDGETS), W.budget),
    ((duration_months || 0) / 72) * W.num,
    (Math.min(team_size || 0, 800) / 800) * W.num,
  ];
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Map a SA project (ZAR budget, SA province) into the corpus vector space.
export function projectToVector(p) {
  const zar = Number(p.budget_total) || 0;
  const usd = zar / 18; // rough ZAR→USD for range bucketing
  const budget_range =
    usd < 1e6 ? '<$1M' : usd < 1e7 ? '$1M–$10M' : usd < 5e7 ? '$10M–$50M' :
    usd < 2.5e8 ? '$50M–$250M' : usd < 1e9 ? '$250M–$1bn' : usd < 5e9 ? '$1bn–$5bn' : '>$5bn';
  let duration_months = 0;
  if (p.start_date && p.target_end_date) {
    duration_months = Math.max(0, (new Date(p.target_end_date) - new Date(p.start_date)) / (86400000 * 30));
  }
  // SA projects map to the Sub-Saharan Africa region of the worldwide corpus.
  return vectorOf({ sector: p.sector, region: 'Sub-Saharan Africa', methodology: p.methodology, budget_range, duration_months, team_size: 0 });
}
