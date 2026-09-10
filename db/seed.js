import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool, queryOne } from './client.js';

const ADMIN_EMAIL = 'karlit@kth-tech.com';
const ADMIN_PASS = 'Godfirst@88399';
const ADMIN_NAME = 'Karli Thebe';
const ORG_NAME = 'KTH Projects';

try {
  const existing = await queryOne('SELECT id FROM users WHERE email = $1', [ADMIN_EMAIL]);
  if (existing) {
    console.log('Seed user already exists — skipping.');
  } else {
    const org = await queryOne(
      'INSERT INTO organisations (name, slug, industry, tier) VALUES ($1, $2, $3, $4) RETURNING *',
      [ORG_NAME, 'kth-projects', 'Technology & PMO', 'command']
    );

    const hash = await bcrypt.hash(ADMIN_PASS, 12);
    const user = await queryOne(
      `INSERT INTO users (org_id, email, password_hash, full_name, role, is_org_admin)
       VALUES ($1, $2, $3, $4, 'admin', TRUE) RETURNING id, email, full_name, role`,
      [org.id, ADMIN_EMAIL, hash, ADMIN_NAME]
    );

    console.log('Seed complete:');
    console.log('  Org:', org.name, '(' + org.id + ')');
    console.log('  User:', user.email, '(' + user.id + ')');
  }

  const demoProject = await queryOne('SELECT id FROM projects WHERE name = $1', ['Project Saloso — National Water Infrastructure Digitisation']);
  if (!demoProject) {
    const org = await queryOne('SELECT id FROM organisations WHERE slug = $1', ['kth-projects']);
    const user = await queryOne('SELECT id FROM users WHERE email = $1', [ADMIN_EMAIL]);

    const project = await queryOne(
      `INSERT INTO projects (org_id, name, code, description, methodology, sector, province, budget_total, currency, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, name`,
      [org.id, 'Project Saloso — National Water Infrastructure Digitisation', 'SAL-001',
       'National Water Infrastructure Digitisation Programme — 142 treatment works across 9 provinces',
       'hybrid', 'WATER', 'NATIONAL', 512000000, 'ZAR', 'active', user.id]
    );

    await queryOne('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [project.id, user.id, 'owner']);

    const risks = [
      { title: 'Scope creep from departmental add-ons', rag: 'amber', prob: 4, impact: 4 },
      { title: 'SCADA vendor dependency — single source', rag: 'red', prob: 5, impact: 5 },
      { title: 'OT security skills gap — only 3 qualified specialists in SA', rag: 'red', prob: 4, impact: 5 },
      { title: 'Legacy system APIs undocumented across 9 provinces', rag: 'amber', prob: 3, impact: 4 },
      { title: 'Community opposition at 2 treatment works sites', rag: 'amber', prob: 3, impact: 3 },
      { title: 'Budget overrun risk — revised ceiling pending Treasury', rag: 'amber', prob: 4, impact: 4 },
      { title: 'Data migration quality inconsistent across provinces', rag: 'amber', prob: 3, impact: 3 },
      { title: 'Political leadership change risk — 3 provincial elections', rag: 'amber', prob: 2, impact: 4 },
    ];

    // Risks table uses text enums, not numeric 1-5. Map the seed's 1..5 to the
    // ('very-low','low','medium','high','very-high') buckets the CHECK allows.
    const RANK = ['very-low', 'very-low', 'low', 'medium', 'high', 'very-high'];
    for (const r of risks) {
      await queryOne(
        `INSERT INTO risks (project_id, title, rag_status, probability, impact, type, created_by)
         VALUES ($1, $2, $3, $4, $5, 'risk', $6)`,
        [project.id, r.title, r.rag, RANK[r.prob] || 'medium', RANK[r.impact] || 'medium', user.id]
      );
    }

    const tasks = [
      { title: 'IoT Sensor Network Phase 2 Deployment', status: 'in-progress', priority: 'high' },
      { title: 'SCADA Firmware v4.2 Integration', status: 'blocked', priority: 'critical' },
      { title: 'National Dashboard v2.0', status: 'done', priority: 'high' },
      { title: 'Provincial Data Migration — EC, FS, MP', status: 'in-progress', priority: 'medium' },
      { title: 'POPIA Compliance Audit', status: 'todo', priority: 'high' },
      { title: 'Community Engagement — Limpopo', status: 'in-progress', priority: 'medium' },
      { title: 'SAP S/4HANA Integration', status: 'todo', priority: 'high' },
      { title: 'OT Security Assessment', status: 'blocked', priority: 'critical' },
    ];

    for (let i = 0; i < tasks.length; i++) {
      await queryOne(
        `INSERT INTO tasks (project_id, title, status, priority, sort_order, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [project.id, tasks[i].title, tasks[i].status, tasks[i].priority, i + 1, user.id]
      );
    }

    // Schema allows: pending | on-track | at-risk | overdue | completed
    const milestones = [
      { title: 'Project Kickoff & Team Onboarding', status: 'completed', due: '2025-12-15' },
      { title: 'Infrastructure & Environment Setup', status: 'completed', due: '2026-02-28' },
      { title: 'IoT Sensor Network Phase 1', status: 'completed', due: '2026-01-08' },
      { title: 'Core System Development', status: 'on-track', due: '2027-08-30' },
      { title: 'SCADA Modernisation', status: 'at-risk', due: '2026-09-30' },
      { title: 'Phase 2 Rollout — EC, FS, MP', status: 'at-risk', due: '2027-03-31' },
      { title: 'National Go-Live', status: 'pending', due: '2027-12-31' },
    ];

    for (const m of milestones) {
      await queryOne(
        `INSERT INTO milestones (project_id, title, status, due_date)
         VALUES ($1, $2, $3, $4)`,
        [project.id, m.title, m.status, m.due]
      );
    }

    console.log('Demo project seeded:', project.name, '(' + project.id + ')');
    console.log('  Risks:', risks.length);
    console.log('  Tasks:', tasks.length);
    console.log('  Milestones:', milestones.length);
  } else {
    console.log('Demo project already exists — skipping.');
  }

} catch (err) {
  console.error('Seed failed:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
