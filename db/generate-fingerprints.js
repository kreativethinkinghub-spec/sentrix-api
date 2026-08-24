/*  SENTRIX — Project Fingerprint™ corpus generator (WORLDWIDE, all domains)
 *  Produces realistic project "DNA" benchmark records spanning every major region
 *  and project domain (software, pharma, aerospace, finance, energy, construction,
 *  media, manufacturing, public sector, R&D, …). Matches the `fingerprints` table.
 *  Deterministic: pass a seed for a reproducible corpus.
 */

// ── seeded PRNG (mulberry32) ────────────────────────────────────────────────
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Global geography: region → countries (ISO2), roughly weighted by activity ──
const REGIONS = [
  { region: 'North America',       w: 16, cc: ['US','US','US','CA','MX'] },
  { region: 'Western Europe',      w: 15, cc: ['GB','DE','FR','NL','ES','IT','SE','CH','IE','BE','PT','AT','NO','DK','FI'] },
  { region: 'Eastern Europe',      w: 6,  cc: ['PL','RO','CZ','HU','GR','UA','BG'] },
  { region: 'Asia-Pacific',        w: 20, cc: ['CN','CN','IN','IN','JP','SG','AU','NZ','KR','ID','MY','TH','PH','VN','HK'] },
  { region: 'South Asia',          w: 5,  cc: ['IN','PK','BD','LK'] },
  { region: 'Middle East',         w: 8,  cc: ['AE','SA','QA','IL','TR','KW','OM'] },
  { region: 'Sub-Saharan Africa',  w: 10, cc: ['ZA','ZA','NG','KE','GH','ET','TZ','BW','NA','ZM','RW'] },
  { region: 'North Africa',        w: 4,  cc: ['EG','MA','TN','DZ'] },
  { region: 'Latin America',       w: 9,  cc: ['BR','BR','AR','CL','CO','PE','UY'] },
];
const REGION_BAG = REGIONS.flatMap(r => Array(r.w).fill(r));

// ── All project domains → sub-domains ──────────────────────────────────────
const DOMAINS = {
  'Software & Digital':        ['SaaS Platform','Cloud Migration','Mobile App','Data Platform','AI/ML System','ERP Rollout','Cybersecurity Programme','Platform Modernisation','DevOps Transformation'],
  'Financial Services':        ['Core Banking Migration','Payments Platform','Regulatory Compliance','Trading System','Digital Bank Launch','Risk & Fraud','Wealth Platform','Open Banking'],
  'Insurance':                 ['Policy Admin System','Claims Automation','Actuarial Platform','InsurTech Launch'],
  'Pharmaceutical & Life Sci': ['Drug Development','Clinical Trial','Manufacturing Scale-up','Regulatory Submission','Cold-Chain Rollout','Lab Digitisation'],
  'Healthcare':                ['Hospital Build','EHR Implementation','Telemedicine Platform','Medical Device Launch','Health System Reform'],
  'Aerospace & Defence':       ['Aircraft Programme','Satellite System','Defence Platform','Avionics Upgrade','MRO Facility'],
  'Space & Satellite':         ['Launch Vehicle','Constellation Deployment','Ground Station','Payload Development'],
  'Automotive':                ['EV Platform','Plant Retooling','ADAS Programme','Supply-Chain Digitisation','Battery Gigafactory'],
  'Energy & Utilities':        ['Grid Modernisation','Smart Metering','Power Plant','Transmission Line','Utility Billing System'],
  'Renewable Energy':          ['Solar Farm','Wind Farm','Battery Storage','Green Hydrogen','Offshore Wind'],
  'Oil & Gas':                 ['LNG Terminal','Refinery Upgrade','Pipeline','Offshore Platform','Decommissioning'],
  'Telecommunications':        ['5G Rollout','Fibre Network','Data Centre','OSS/BSS Transformation','Submarine Cable'],
  'Media & Entertainment':     ['Film Production','Streaming Platform','Game Development','Broadcast Infrastructure','Live Event'],
  'Retail & E-commerce':       ['Omnichannel Platform','Store Rollout','Fulfilment Centre','POS Modernisation','Marketplace Launch'],
  'Consumer Goods (FMCG)':     ['Product Launch','Plant Expansion','Supply-Chain Redesign','Packaging Line','Brand Rebuild'],
  'Manufacturing':             ['Smart Factory','Line Automation','Industry 4.0','Warehouse Automation','Quality System'],
  'Construction & Infra':      ['High-Rise','Metro Rail','Highway','Bridge','Airport','Water Treatment','Stadium'],
  'Mining & Metals':           ['New Mine','Processing Plant','Tailings Facility','Smelter','Mine Automation'],
  'Chemicals':                 ['Petrochemical Plant','Specialty Chemicals','Fertiliser Facility','Process Upgrade'],
  'Transportation & Logistics':['Port Expansion','Rail Freight','Last-Mile Network','Fleet Digitisation','Logistics Hub'],
  'Real Estate':               ['Mixed-Use Development','Office Tower','Residential Estate','Data-Centre Campus','Retail Precinct'],
  'Hospitality & Tourism':     ['Hotel Development','Resort Build','Casino & Leisure','Booking Platform'],
  'Agriculture & Agritech':    ['Irrigation Scheme','Agri-Processing','Precision-Ag Platform','Cold Storage','Aquaculture'],
  'Education':                 ['University Campus','EdTech Platform','School Network','Research Facility','LMS Rollout'],
  'Government & Public Sector': ['Digital Government','National ID','Tax Modernisation','Smart City','E-Services'],
  'Non-profit & Development':  ['Humanitarian Programme','Rural Electrification','WASH Programme','Health Campaign'],
  'Professional Services':     ['Firm Transformation','Practice Platform','Global Rollout','Shared-Services Centre'],
  'Marketing & Advertising':   ['Global Campaign','Brand Platform','MarTech Stack','Rebrand Programme'],
  'Biotechnology':             ['Bioprocess Facility','Genomics Platform','Vaccine Programme','Lab Scale-up'],
};
const DOMAIN_KEYS = Object.keys(DOMAINS);

const METHODOLOGIES = ['agile','scrum','kanban','waterfall','hybrid','prince2','pmbok','safe','lean','six-sigma','stage-gate','devops'];
const BUDGET_RANGES = ['<$1M','$1M–$10M','$10M–$50M','$50M–$250M','$250M–$1bn','$1bn–$5bn','>$5bn'];
const OUTCOMES = ['on-time','on-time','on-time','delayed','delayed','delayed','delayed','over-budget','over-budget','mixed','mixed','cancelled'];
const SOURCES = ['PMI Benchmark','Standish CHAOS','Industry Panel','Public Filings','Government eProcurement','IPA Major Projects','DBSA / IFI Portfolio','Analyst Database','Vendor Case Study'];

const COMPLIANCE = ['ISO 9001','ISO 27001','ISO 14001','ISO 45001','GDPR','SOX','HIPAA','FDA 21 CFR','EMA GMP','PCI-DSS','Basel III','IFRS','US GAAP','ITAR','NIST CSF','FedRAMP','PMBOK','PRINCE2','AS9100','IATF 16949','NERC','FERC','FIDIC','LEED','King IV','PFMA','NEMA'];
const TECH = ['Primavera P6','MS Project','Jira','SAP S/4HANA','Oracle','Salesforce','ServiceNow','Power BI','Tableau','Azure DevOps','AWS','GCP','Kubernetes','Procore','Autodesk BIM 360','Oracle Aconex','Workday','Anaplan','Smartsheet','Asana','Snowflake','Databricks'];
const FIRMS = [
  // EPC / construction
  'Bechtel','Fluor','AECOM','Jacobs','Vinci','Bouygues','Skanska','Turner Construction','Kiewit','Balfour Beatty','Ferrovial','Hochtief','Samsung C&T','Larsen & Toubro','China State Construction','Obayashi',
  // consulting / systems integration
  'Accenture','Deloitte','PwC','EY','KPMG','McKinsey','BCG','Capgemini','Infosys','TCS','Wipro','IBM','Cognizant','Atos','DXC',
  // industrial / tech OEM
  'Siemens','ABB','Schneider Electric','GE','Honeywell','Bosch','Thales','Airbus','Boeing','Ericsson','Nokia','Huawei',
  // regional (SA & emerging)
  'Raubex','WBHO','Stefanutti Stocks','Zutari','Royal HaskoningDHV'
];

const CODE = ['Atlas','Orion','Titan','Apollo','Helix','Vega','Nimbus','Zenith','Catalyst','Quantum','Meridian','Everest','Falcon','Aurora','Phoenix','Odyssey','Pinnacle','Horizon','Summit','Genesis','Nova','Pulsar','Cobalt','Sentinel','Mosaic','Lighthouse','Keystone','Vanguard','Beacon','Compass','Trident','Polaris','Aegis','Nexus','Vertex','Onyx','Cipher','Delta','Echo','Frontier'];

function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
function pickN(r, arr, n) {
  const out = new Set();
  const k = 1 + Math.floor(r() * n);
  let g = 0;
  while (out.size < k && g++ < 40) out.add(pick(r, arr));
  return [...out];
}
function score(r, mean, spread) {
  let v = 0; for (let i = 0; i < 3; i++) v += r();
  v = (v / 3 - 0.5) * 2 * spread + mean;
  return Math.max(5, Math.min(99, Math.round(v * 10) / 10));
}

// Domain "personality" — mean dimension scores (0–100); default for the rest.
const PROFILE = {
  'Software & Digital':        { risk: 58, delivery: 66, esg: 60, supply: 74, gov: 62 },
  'Financial Services':        { risk: 64, delivery: 68, esg: 66, supply: 70, gov: 82 },
  'Pharmaceutical & Life Sci': { risk: 66, delivery: 62, esg: 72, supply: 64, gov: 86 },
  'Aerospace & Defence':       { risk: 72, delivery: 60, esg: 64, supply: 66, gov: 88 },
  'Oil & Gas':                 { risk: 76, delivery: 58, esg: 52, supply: 62, gov: 74 },
  'Renewable Energy':          { risk: 60, delivery: 70, esg: 82, supply: 60, gov: 72 },
  'Construction & Infra':      { risk: 68, delivery: 61, esg: 60, supply: 56, gov: 70 },
  'Government & Public Sector': { risk: 66, delivery: 58, esg: 64, supply: 58, gov: 78 },
  'Media & Entertainment':     { risk: 62, delivery: 64, esg: 58, supply: 66, gov: 55 },
};

export function generateFingerprint(r) {
  const dom = pick(r, DOMAIN_KEYS);
  const sub = pick(r, DOMAINS[dom]);
  const region = pick(r, REGION_BAG);
  const cc = pick(r, region.cc);
  const method = pick(r, METHODOLOGIES);
  const p = PROFILE[dom] || { risk: 63, delivery: 65, esg: 63, supply: 63, gov: 70 };

  const complexity = score(r, 60, 22);
  const risk = score(r, p.risk, 18);
  const delivery = score(r, p.delivery, 18);
  const governance = score(r, p.gov, 15);
  const esg = score(r, p.esg, 18);
  const supply = score(r, p.supply, 20);
  const team = score(r, 66, 16);

  const duration = 3 + Math.floor(r() * 72);       // 3–75 months
  const teamSize = 4 + Math.floor(r() * 800);      // 4–804
  const outcome = pick(r, OUTCOMES);
  const budget = pick(r, BUDGET_RANGES);

  const name = `Project ${pick(r, CODE)} — ${sub} (${cc})`;
  const dimensions = { team, risk, delivery, governance, esg, supply_chain: supply, complexity };

  return {
    name,
    sector: dom,
    sub_sector: sub,
    province: region.region,        // macro-region (worldwide corpus)
    country_code: cc,
    budget_range: budget,
    duration_months: duration,
    team_size: teamSize,
    methodology: method,
    complexity_score: complexity,
    risk_score: risk,
    delivery_score: delivery,
    governance_score: governance,
    esg_score: esg,
    supply_chain_score: supply,
    team_score: team,
    outcome,
    lessons_learned: `${outcome === 'on-time' ? 'Delivered to baseline' : outcome === 'over-budget' ? 'Cost pressure on ' + sub.toLowerCase() : 'Schedule variance actively managed'} under ${method.toUpperCase()} governance in ${region.region}.`,
    compliance_frameworks: pickN(r, COMPLIANCE, 4),
    tech_stack: pickN(r, TECH, 3),
    contractors: pickN(r, FIRMS, 3),
    source: pick(r, SOURCES),
    is_verified: r() < 0.35,
    dimensions
  };
}

export function generateFingerprints(count, seed = 20260822) {
  const r = rng(seed);
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = generateFingerprint(r);
  return out;
}

// CLI: `node db/generate-fingerprints.js 100000 [outfile.ndjson]`
import { fileURLToPath } from 'url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const n = parseInt(process.argv[2]) || 1000;
  const out = process.argv[3];
  const recs = generateFingerprints(n);
  if (out) {
    const fs = await import('fs');
    fs.writeFileSync(out, recs.map(x => JSON.stringify(x)).join('\n'));
    console.log(`Wrote ${recs.length} fingerprints → ${out}`);
  } else {
    console.log(JSON.stringify(recs[0], null, 2));
    console.log(`\nGenerated ${recs.length} records (showing #1).`);
  }
}
