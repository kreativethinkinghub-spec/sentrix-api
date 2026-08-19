-- SENTRIX Database Schema
-- Supabase PostgreSQL

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ═══════════════════════════════════════
-- 1. ORGANISATIONS & USERS
-- ═══════════════════════════════════════

CREATE TABLE organisations (
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

CREATE TABLE users (
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

CREATE INDEX idx_users_org ON users(org_id);
CREATE INDEX idx_users_email ON users(email);

-- ═══════════════════════════════════════
-- 2. PROJECTS
-- ═══════════════════════════════════════

CREATE TABLE projects (
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

CREATE INDEX idx_projects_org ON projects(org_id);
CREATE INDEX idx_projects_status ON projects(status);

-- ═══════════════════════════════════════
-- 3. PROJECT TEAM MEMBERS
-- ═══════════════════════════════════════

CREATE TABLE project_members (
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

CREATE TABLE tasks (
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

CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX idx_tasks_status ON tasks(status);

-- ═══════════════════════════════════════
-- 5. RISKS (RAID LOG)
-- ═══════════════════════════════════════

CREATE TABLE risks (
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

CREATE INDEX idx_risks_project ON risks(project_id);
CREATE INDEX idx_risks_status ON risks(status);

-- ═══════════════════════════════════════
-- 6. MILESTONES & TIMELINE
-- ═══════════════════════════════════════

CREATE TABLE milestones (
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

CREATE INDEX idx_milestones_project ON milestones(project_id);

-- ═══════════════════════════════════════
-- 7. DOCUMENTS
-- ═══════════════════════════════════════

CREATE TABLE documents (
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

CREATE INDEX idx_documents_project ON documents(project_id);

-- ═══════════════════════════════════════
-- 8. BUDGET LINE ITEMS
-- ═══════════════════════════════════════

CREATE TABLE budget_items (
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

CREATE INDEX idx_budget_project ON budget_items(project_id);

-- ═══════════════════════════════════════
-- 9. AUDIT LOG
-- ═══════════════════════════════════════

CREATE TABLE audit_log (
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

CREATE INDEX idx_audit_org ON audit_log(org_id);
CREATE INDEX idx_audit_project ON audit_log(project_id);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

-- ═══════════════════════════════════════
-- 10. PROJECT FINGERPRINT
-- ═══════════════════════════════════════

CREATE TABLE fingerprints (
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

CREATE INDEX idx_fp_sector ON fingerprints(sector);
CREATE INDEX idx_fp_country ON fingerprints(country_code);
CREATE INDEX idx_fp_org ON fingerprints(org_id);

-- ═══════════════════════════════════════
-- 11. NOTIFICATIONS
-- ═══════════════════════════════════════

CREATE TABLE notifications (
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

CREATE INDEX idx_notif_user ON notifications(user_id, is_read);

-- ═══════════════════════════════════════
-- 12. AI INSIGHTS CACHE
-- ═══════════════════════════════════════

CREATE TABLE ai_insights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('risk-prediction','budget-forecast','delivery-forecast','recommendation','weekly-summary','board-pack')),
  content JSONB NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX idx_ai_project ON ai_insights(project_id);

-- ═══════════════════════════════════════
-- 13. CONNECTORS (INTEGRATIONS)
-- ═══════════════════════════════════════

CREATE TABLE connectors (
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

CREATE INDEX idx_connectors_org ON connectors(org_id);

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

CREATE TRIGGER trg_organisations_updated BEFORE UPDATE ON organisations FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_projects_updated BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_tasks_updated BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_risks_updated BEFORE UPDATE ON risks FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_budget_updated BEFORE UPDATE ON budget_items FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS is enforced at the application layer via org_id filtering in queries
