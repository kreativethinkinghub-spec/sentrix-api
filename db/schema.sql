-- SENTRIX Database Schema
-- Supabase PostgreSQL

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ═══════════════════════════════════════
-- 1. ORGANISATIONS & USERS
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS organisations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  industry TEXT,
  size TEXT CHECK (size IN ('1-10','11-50','51-200','201-1000','1000+')),
  country_code CHAR(2) DEFAULT 'ZA',
  tier TEXT NOT NULL DEFAULT 'professional' CHECK (tier IN ('professional','growth','command','sovereign')),
  billing_cycle TEXT DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','annual')),
  max_users INT NOT NULL DEFAULT 5,
  max_projects INT NOT NULL DEFAULT 10,
  is_active BOOLEAN DEFAULT TRUE,
  trial_ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'pm' CHECK (role IN ('ceo','director','pm','finance','risk','tech','auditor','minister','contractor','admin')),
  is_org_admin BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ═══════════════════════════════════════
-- 2. PROJECTS
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  description TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('setup','active','on-hold','completed','cancelled')),
  methodology TEXT DEFAULT 'hybrid' CHECK (methodology IN ('hybrid','agile','waterfall','prince2','safe','pmbok')),
  sector TEXT,
  province TEXT,
  country_code CHAR(2) DEFAULT 'ZA',
  budget_total NUMERIC(15,2),
  budget_spent NUMERIC(15,2) DEFAULT 0,
  currency CHAR(3) DEFAULT 'ZAR',
  start_date DATE,
  target_end_date DATE,
  actual_end_date DATE,
  programme_name TEXT,
  client_name TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- ═══════════════════════════════════════
-- 3. PROJECT TEAM MEMBERS
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS project_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, user_id)
);

-- ═══════════════════════════════════════
-- 4. TASKS
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'todo' CHECK (status IN ('todo','in-progress','review','done','blocked')),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('critical','high','medium','low')),
  assigned_to UUID REFERENCES users(id),
  due_date DATE,
  completed_at TIMESTAMPTZ,
  sort_order INT DEFAULT 0,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- ═══════════════════════════════════════
-- 5. RISKS (RAID LOG)
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS risks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'risk' CHECK (type IN ('risk','assumption','issue','dependency')),
  title TEXT NOT NULL,
  description TEXT,
  probability TEXT CHECK (probability IN ('very-low','low','medium','high','very-high')),
  impact TEXT CHECK (impact IN ('very-low','low','medium','high','very-high')),
  rag_status TEXT DEFAULT 'amber' CHECK (rag_status IN ('red','amber','green')),
  mitigation TEXT,
  owner_id UUID REFERENCES users(id),
  status TEXT DEFAULT 'open' CHECK (status IN ('open','mitigating','resolved','accepted','escalated')),
  raised_date DATE DEFAULT CURRENT_DATE,
  target_date DATE,
  resolved_date DATE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risks_project ON risks(project_id);
CREATE INDEX IF NOT EXISTS idx_risks_status ON risks(status);

-- ═══════════════════════════════════════
-- 6. MILESTONES & TIMELINE
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS milestones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  due_date DATE NOT NULL,
  completed_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','on-track','at-risk','overdue','completed')),
  phase TEXT,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id);

-- ═══════════════════════════════════════
-- 7. DOCUMENTS
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  file_url TEXT,
  file_size BIGINT,
  mime_type TEXT,
  category TEXT DEFAULT 'general' CHECK (category IN ('general','report','contract','compliance','evidence','minutes','specification')),
  uploaded_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);

-- ═══════════════════════════════════════
-- 8. BUDGET LINE ITEMS
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS budget_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  description TEXT,
  planned_amount NUMERIC(15,2) NOT NULL,
  actual_amount NUMERIC(15,2) DEFAULT 0,
  currency CHAR(3) DEFAULT 'ZAR',
  period TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_budget_project ON budget_items(project_id);

-- ═══════════════════════════════════════
-- 9. AUDIT LOG
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  details JSONB,
  ip_address INET,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

-- ═══════════════════════════════════════
-- 10. PROJECT FINGERPRINT
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS fingerprints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  org_id UUID REFERENCES organisations(id),
  name TEXT NOT NULL,
  sector TEXT,
  sub_sector TEXT,
  province TEXT,
  country_code CHAR(2) DEFAULT 'ZA',
  budget_range TEXT,
  duration_months INT,
  team_size INT,
  methodology TEXT,
  complexity_score NUMERIC(5,2),
  risk_score NUMERIC(5,2),
  delivery_score NUMERIC(5,2),
  governance_score NUMERIC(5,2),
  esg_score NUMERIC(5,2),
  supply_chain_score NUMERIC(5,2),
  team_score NUMERIC(5,2),
  outcome TEXT CHECK (outcome IN ('on-time','delayed','over-budget','cancelled','mixed','unknown')),
  lessons_learned TEXT,
  compliance_frameworks TEXT[],
  tech_stack TEXT[],
  contractors TEXT[],
  source TEXT,
  is_verified BOOLEAN DEFAULT FALSE,
  dimensions JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fp_sector ON fingerprints(sector);
CREATE INDEX IF NOT EXISTS idx_fp_country ON fingerprints(country_code);
CREATE INDEX IF NOT EXISTS idx_fp_org ON fingerprints(org_id);

-- ═══════════════════════════════════════
-- 11. NOTIFICATIONS
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('risk','task','milestone','budget','system','ai-insight')),
  title TEXT NOT NULL,
  body TEXT,
  is_read BOOLEAN DEFAULT FALSE,
  action_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);

-- ═══════════════════════════════════════
-- 12. AI INSIGHTS CACHE
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS ai_insights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('risk-prediction','budget-forecast','delivery-forecast','recommendation','weekly-summary','board-pack')),
  content JSONB NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_project ON ai_insights(project_id);

-- ═══════════════════════════════════════
-- 13. CONNECTORS (INTEGRATIONS)
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS connectors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('jira','azure-devops','ms-project','sap','power-bi','primavera','sharepoint','teams','custom')),
  config JSONB,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connectors_org ON connectors(org_id);

-- ═══════════════════════════════════════
-- 14. PAYMENTS (Paystack subscriptions)
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  reference TEXT UNIQUE NOT NULL,
  tier TEXT,
  billing_cycle TEXT,
  amount NUMERIC(15,2),
  currency CHAR(3) DEFAULT 'ZAR',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed')),
  paystack_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payments_org ON payments(org_id);

-- ═══════════════════════════════════════
-- 15. CHANGE MANAGEMENT (change requests / variation orders)
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS change_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reference TEXT,
  title TEXT NOT NULL,
  type TEXT DEFAULT 'scope' CHECK (type IN ('scope','schedule','cost','quality','resource')),
  description TEXT,
  justification TEXT,
  cost_impact NUMERIC(15,2) DEFAULT 0,
  schedule_impact_days INT DEFAULT 0,
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('critical','high','medium','low')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','under-review','approved','rejected','implemented')),
  raised_by UUID REFERENCES users(id),
  decided_by UUID REFERENCES users(id),
  decision_notes TEXT,
  raised_date DATE DEFAULT CURRENT_DATE,
  decided_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_change_project ON change_requests(project_id);

-- ═══════════════════════════════════════
-- 16. CYBER / OT RISK ASSESSMENTS
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS cyber_assessments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  has_ot BOOLEAN DEFAULT FALSE,
  iec62443_score NUMERIC(5,2),
  iso27001_score NUMERIC(5,2),
  nist_score NUMERIC(5,2),
  popia_score NUMERIC(5,2),
  supply_chain_score NUMERIC(5,2),
  ot_exposure TEXT DEFAULT 'none' CHECK (ot_exposure IN ('none','low','medium','high','critical')),
  posture_score NUMERIC(5,2),
  findings JSONB,
  assessed_by UUID REFERENCES users(id),
  assessed_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id)
);
CREATE INDEX IF NOT EXISTS idx_cyber_project ON cyber_assessments(project_id);

-- ═══════════════════════════════════════
-- 17. TRAINING / ENABLEMENT (PM upskilling)
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS training_modules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  level TEXT DEFAULT 'core' CHECK (level IN ('core','intermediate','advanced')),
  duration_min INT DEFAULT 15,
  summary TEXT,
  content JSONB,
  sort_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS training_progress (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id UUID NOT NULL REFERENCES training_modules(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'not-started' CHECK (status IN ('not-started','in-progress','completed')),
  progress_pct INT DEFAULT 0,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, module_id)
);
CREATE INDEX IF NOT EXISTS idx_training_user ON training_progress(user_id);

-- ═══════════════════════════════════════
-- 18. ERP IMPORTS (SAP / Primavera / MS Project — generic ingest log)
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS erp_imports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  provider TEXT,
  kind TEXT,
  rows_imported INT DEFAULT 0,
  summary JSONB,
  imported_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_erpimports_org ON erp_imports(org_id);

-- ═══════════════════════════════════════
-- 19. CONTRACTOR PERFORMANCE
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS contractors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sector TEXT,
  registration_no TEXT,
  cidb_grade TEXT,
  bbbee_level INT,
  contact_email TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contractors_org ON contractors(org_id);

CREATE TABLE IF NOT EXISTS contractor_ratings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contractor_id UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  delivery_score INT CHECK (delivery_score BETWEEN 0 AND 100),
  quality_score INT CHECK (quality_score BETWEEN 0 AND 100),
  safety_score INT CHECK (safety_score BETWEEN 0 AND 100),
  cost_score INT CHECK (cost_score BETWEEN 0 AND 100),
  notes TEXT,
  rated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ratings_contractor ON contractor_ratings(contractor_id);

-- ═══════════════════════════════════════
-- 20. MFA (TOTP) — optional per-user
-- ═══════════════════════════════════════

ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS alerts_optin BOOLEAN DEFAULT TRUE;

-- ═══════════════════════════════════════
-- 21. SSO (OIDC) — per-org enterprise single sign-on
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS sso_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  provider TEXT DEFAULT 'oidc',
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  default_role TEXT DEFAULT 'pm',
  enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (org_id)
);

-- ═══════════════════════════════════════
-- 22. SCHEDULE ENGINE (critical path) — task durations + dependencies
-- ═══════════════════════════════════════

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS duration_days INT DEFAULT 1;

CREATE TABLE IF NOT EXISTS task_dependencies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,          -- successor
  depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, -- predecessor
  type TEXT DEFAULT 'FS' CHECK (type IN ('FS','SS','FF','SF')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (task_id, depends_on_task_id)
);
CREATE INDEX IF NOT EXISTS idx_taskdep_task ON task_dependencies(task_id);

-- ═══════════════════════════════════════
-- 23. BASELINE MANAGEMENT (scope / cost / schedule snapshots)
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS baselines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'full' CHECK (type IN ('scope','cost','schedule','full')),
  snapshot JSONB NOT NULL,
  is_current BOOLEAN DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_baselines_project ON baselines(project_id);

-- Change management: contract linkage, delegated-authority routing, baseline link.
ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS contractor_id UUID REFERENCES contractors(id) ON DELETE SET NULL;
ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS required_approver TEXT;
ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS baseline_id UUID REFERENCES baselines(id) ON DELETE SET NULL;

-- Delegation-of-authority thresholds (ZAR). Above pm → director; above director → sponsor.
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS change_threshold_pm NUMERIC(15,2) DEFAULT 100000;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS change_threshold_director NUMERIC(15,2) DEFAULT 1000000;

-- ═══════════════════════════════════════
-- UPDATED_AT TRIGGER
-- ═══════════════════════════════════════

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_organisations_updated BEFORE UPDATE ON organisations FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER trg_projects_updated BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER trg_tasks_updated BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER trg_risks_updated BEFORE UPDATE ON risks FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER trg_budget_updated BEFORE UPDATE ON budget_items FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS is enforced at the application layer via org_id filtering in queries

-- ═══════════════════════════════════════
-- 24. COMMUNICATIONS PORTAL (change-mgmt comms plans + notices)
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS comms_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  change_id UUID REFERENCES change_requests(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT,
  audiences JSONB DEFAULT '[]',        -- [{segment, role, interest, message, channel, cadence}]
  key_messages JSONB DEFAULT '[]',
  channels TEXT[] DEFAULT '{}',
  owner_id UUID REFERENCES users(id),
  approver_role TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','published','archived')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_comms_project ON comms_plans(project_id);
CREATE INDEX IF NOT EXISTS idx_comms_change ON comms_plans(change_id);

CREATE TABLE IF NOT EXISTS comms_notices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  plan_id UUID NOT NULL REFERENCES comms_plans(id) ON DELETE CASCADE,
  audience TEXT NOT NULL,
  channel TEXT NOT NULL,             -- portal | email | sms | whatsapp
  recipient TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','read')),
  sent_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notice_plan ON comms_notices(plan_id);
CREATE OR REPLACE TRIGGER trg_comms_plans_updated BEFORE UPDATE ON comms_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════
-- 25. SIGNUP REQUESTS (public trial + invoice-request captures)
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS signup_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind TEXT NOT NULL CHECK (kind IN ('trial','invoice')),
  plan TEXT NOT NULL CHECK (plan IN ('pro','growth','command','sovereign')),
  billing TEXT NOT NULL DEFAULT 'monthly' CHECK (billing IN ('monthly','annual')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','converted','rejected','spam')),

  -- Common contact fields
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  contact_name TEXT,
  contact_title TEXT,
  phone TEXT,
  company TEXT NOT NULL,
  role TEXT,

  -- Invoice-specific
  reg_no TEXT,
  vat_no TEXT,
  org_type TEXT,
  billing_address TEXT,
  users INTEGER,
  start_date DATE,
  po_ref TEXT,
  notes TEXT,
  cycle TEXT,       -- radio value from the invoice form (monthly|annual)

  -- Trial-specific
  use_case TEXT,

  -- Provenance / anti-spam
  source TEXT,
  ip TEXT,
  user_agent TEXT,
  raw JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  contacted_at TIMESTAMPTZ,
  converted_at TIMESTAMPTZ,
  organisation_id UUID REFERENCES organisations(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_signup_email ON signup_requests(email);
CREATE INDEX IF NOT EXISTS idx_signup_kind_status ON signup_requests(kind, status);
CREATE INDEX IF NOT EXISTS idx_signup_created ON signup_requests(created_at DESC);
