import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import taskRoutes from './routes/tasks.js';
import riskRoutes from './routes/risks.js';
import fingerprintRoutes from './routes/fingerprint.js';
import milestoneRoutes from './routes/milestones.js';
import budgetRoutes from './routes/budget.js';
import documentRoutes from './routes/documents.js';
import notificationRoutes from './routes/notifications.js';
import auditRoutes from './routes/audit.js';
import insightRoutes from './routes/insights.js';
import connectorRoutes from './routes/connectors.js';
import userRoutes from './routes/users.js';
import billingRoutes, { paystackWebhook } from './routes/billing.js';
import changeRoutes from './routes/change.js';
import cyberRoutes from './routes/cyber.js';
import costRoutes from './routes/cost.js';
import trainingRoutes from './routes/training.js';
import erpRoutes from './routes/erp.js';
import contractorRoutes from './routes/contractors.js';
import portfolioRoutes from './routes/portfolio.js';
import reportRoutes from './routes/reports.js';
import alertRoutes from './routes/alerts.js';
import mfaRoutes from './routes/mfa.js';
import ssoRoutes from './routes/sso.js';
import scheduleRoutes from './routes/schedule.js';
import baselineRoutes from './routes/baseline.js';
import { query } from './db/client.js';
import { authenticate } from './middleware/auth.js';

const app = express();
const PORT = process.env.PORT || 4800;

app.use(helmet());

// Paystack webhook needs the RAW body for HMAC signature validation — mount it
// BEFORE express.json() (public, no auth).
app.post('/api/billing/webhook', express.raw({ type: '*/*' }), paystackWebhook);

app.use(express.json({ limit: '10mb' }));
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:8686'],
  credentials: true
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

app.get('/api/health', async (_req, res) => {
  // Liveness is always ok; db is a readiness signal (does not fail the check).
  let db = 'unknown';
  try { await query('SELECT 1'); db = 'up'; } catch { db = 'down'; }
  res.json({ status: 'ok', db, version: '1.0.0', uptime: Math.round(process.uptime()) });
});

app.use('/api/auth', authRoutes);
app.use('/api/sso', ssoRoutes);   // public start/callback; config routes gate internally
app.use('/api/projects', authenticate, projectRoutes);
app.use('/api/tasks', authenticate, taskRoutes);
app.use('/api/risks', authenticate, riskRoutes);
app.use('/api/fingerprint', authenticate, fingerprintRoutes);
app.use('/api/milestones', authenticate, milestoneRoutes);
app.use('/api/budget', authenticate, budgetRoutes);
app.use('/api/documents', authenticate, documentRoutes);
app.use('/api/notifications', authenticate, notificationRoutes);
app.use('/api/audit', authenticate, auditRoutes);
app.use('/api/insights', authenticate, insightRoutes);
app.use('/api/connectors', authenticate, connectorRoutes);
app.use('/api/users', authenticate, userRoutes);
app.use('/api/billing', authenticate, billingRoutes);
app.use('/api/change', authenticate, changeRoutes);
app.use('/api/cyber', authenticate, cyberRoutes);
app.use('/api/cost', authenticate, costRoutes);
app.use('/api/training', authenticate, trainingRoutes);
app.use('/api/erp', authenticate, erpRoutes);
app.use('/api/contractors', authenticate, contractorRoutes);
app.use('/api/portfolio', authenticate, portfolioRoutes);
app.use('/api/reports', authenticate, reportRoutes);
app.use('/api/alerts', authenticate, alertRoutes);
app.use('/api/mfa', authenticate, mfaRoutes);
app.use('/api/schedule', authenticate, scheduleRoutes);
app.use('/api/baseline', authenticate, baselineRoutes);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`SENTRIX API running on port ${PORT}`);
});
