require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { initializeDatabase, get, all, run, saveDb } = require('./database');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

// ── Security Middleware ────────────────────────────────────────────────────────

// Helmet: set secure HTTP headers
app.use(helmet({
  contentSecurityPolicy: false,   // disabled so frontend SPA works
  crossOriginEmbedderPolicy: false,
}));

// CORS configuration – always include production origins
const prodOrigins = [
  'https://hausdorff-crm-production.up.railway.app',
  'https://crm.hausdorff.co.il',
  'http://localhost:5173',
];
const envOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : [];
const corsOrigins = [...new Set([...prodOrigins, ...envOrigins])];

app.use(cors({
  origin: isProd
    ? corsOrigins
    : true,   // allow all origins in development
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Global rate limiter: 100 requests per 15 minutes per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 100 : 1000,   // relaxed in dev
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי בקשות. אנא נסה שוב מאוחר יותר.' },
});
app.use('/api/', globalLimiter);

// Strict login rate limiter: 5 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 5 : 50,       // relaxed in dev
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי ניסיונות התחברות. אנא נסה שוב בעוד 15 דקות.' },
  skipSuccessfulRequests: true,
});

// Body parser
app.use(express.json({ limit: '10mb' }));

// Request logger (dev only)
if (!isProd) {
  app.use((req, _res, next) => {
    if (req.path.startsWith('/api/')) {
      console.log(`${new Date().toISOString().slice(11,19)} ${req.method} ${req.path}`);
    }
    next();
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Public routes (no auth) — login has its own rate limiter
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', require('./routes/auth'));

// Protected routes
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/companies', require('./routes/companies'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/properties', require('./routes/properties'));
app.use('/api/deals', require('./routes/deals'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/timeline', require('./routes/timeline'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/attachments', require('./routes/attachments'));
app.use('/api/proposals', require('./routes/proposals'));
app.use('/api/activities', require('./routes/activities'));
app.use('/api/goals', require('./routes/goals'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/meetings', require('./routes/meetings'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/whatsapp', require('./routes/whatsapp'));

// Serve uploaded files
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
app.use('/uploads', express.static(uploadsDir));

// Property files upload route
app.use('/api/property-files', require('./routes/property_files'));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', env: NODE_ENV, timestamp: new Date().toISOString() });
});

// ── Serve Frontend in Production ──────────────────────────────────────────────
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  // SPA fallback: serve index.html for any non-API route
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/uploads/')) {
      res.sendFile(path.join(frontendDist, 'index.html'));
    }
  });
  console.log('[Server] Serving frontend from', frontendDist);
}

// ── Smart Match Scheduler ───────────────────────────────────────────────────
function runSmartMatchJob() {
  console.log('[SmartMatch] Running daily match job...');
  try {
    const contacts = all(`SELECT * FROM contacts WHERE status = 'פעיל'`);
    const properties = all(`SELECT * FROM properties WHERE status = 'זמין'`);
    let matchCount = 0;

    contacts.forEach(contact => {
      const preferredAreas = JSON.parse(contact.preferred_areas || '[]');
      const preferredTypes = JSON.parse(contact.preferred_property_types || '[]');

      properties.forEach(prop => {
        // Check if notification already exists today
        const today = new Date().toISOString().split('T')[0];
        const existing = get(
          `SELECT id FROM match_notifications WHERE contact_id=? AND property_id=? AND date(created_at)=?`,
          [contact.id, prop.id, today]
        );
        if (existing) return;

        let score = 0;
        const reasons = [];
        let isYieldMatch = false;

        // Location (40 pts)
        if (preferredAreas.length > 0 && preferredAreas.some(a =>
          (prop.city||'').includes(a) || (prop.neighborhood||'').includes(a))) {
          score += 40; reasons.push('מיקום מתאים');
        }

        // Price (30 pts)
        if (contact.budget_min > 0 || contact.budget_max > 0) {
          if (prop.price >= (contact.budget_min || 0) && (contact.budget_max === 0 || prop.price <= contact.budget_max)) {
            score += 30; reasons.push('מחיר בטווח התקציב');
          } else if (contact.budget_max > 0 && prop.price <= contact.budget_max * 1.1) {
            score += 15; reasons.push('מחיר קרוב לתקציב');
          }
        } else { score += 15; }

        // Area (15 pts)
        if (contact.min_area > 0 || contact.max_area > 0) {
          if (prop.area >= (contact.min_area || 0) && (contact.max_area === 0 || prop.area <= contact.max_area)) {
            score += 15; reasons.push('גודל מתאים');
          }
        } else { score += 10; }

        // Rooms (15 pts)
        if (contact.min_rooms > 0 || contact.max_rooms > 0) {
          if (prop.rooms >= (contact.min_rooms || 0) && (contact.max_rooms === 0 || prop.rooms <= contact.max_rooms)) {
            score += 15; reasons.push('מספר חדרים מתאים');
          }
        } else { score += 10; }

        // Yield match
        if (contact.desired_yield > 0 && prop.annual_yield >= contact.desired_yield) {
          score = Math.max(score, 80);
          reasons.push(`תשואה ${prop.annual_yield}% >= ${contact.desired_yield}% המבוקש`);
          isYieldMatch = true;
        }

        if (score >= 80) {
          run(`INSERT INTO match_notifications (id,contact_id,property_id,score,reasons,is_yield_match,seen,created_at) VALUES (?,?,?,?,?,?,0,?)`,
            [uuidv4(), contact.id, prop.id, score, JSON.stringify(reasons), isYieldMatch ? 1 : 0, new Date().toISOString()]);
          matchCount++;
        }
      });
    });

    console.log(`[SmartMatch] Job complete. ${matchCount} new matches found.`);
  } catch (err) {
    console.error('[SmartMatch] Error:', err.message);
  }
}

// Run at 6:00 AM every day
cron.schedule('0 6 * * *', runSmartMatchJob, { timezone: 'Asia/Jerusalem' });

// ── Database Backup Scheduler ────────────────────────────────────────────────
function runBackup() {
  const backupDir = path.resolve(__dirname, process.env.BACKUP_DIR || './backups');
  const keepCount = parseInt(process.env.BACKUP_KEEP_COUNT) || 7;
  const dbPath = path.resolve(__dirname, process.env.DB_PATH || './crm.db');

  try {
    // Create backup directory if it doesn't exist
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    // Create backup with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = path.join(backupDir, `crm-backup-${timestamp}.db`);

    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, backupFile);
      console.log(`[Backup] Created: ${backupFile}`);
    } else {
      console.warn('[Backup] Database file not found at', dbPath);
      return;
    }

    // Prune old backups — keep only the most recent N
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('crm-backup-') && f.endsWith('.db'))
      .sort()
      .reverse();

    if (files.length > keepCount) {
      const toDelete = files.slice(keepCount);
      toDelete.forEach(f => {
        fs.unlinkSync(path.join(backupDir, f));
        console.log(`[Backup] Pruned old backup: ${f}`);
      });
    }

    console.log(`[Backup] Complete. ${Math.min(files.length, keepCount)} backups retained.`);
  } catch (err) {
    console.error('[Backup] Error:', err.message);
  }
}

// Run backup at 2:00 AM every day
cron.schedule('0 2 * * *', runBackup, { timezone: 'Asia/Jerusalem' });

// ── Start server ────────────────────────────────────────────────────────────
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`\n  Real Estate CRM Backend`);
    console.log(`  Environment: ${NODE_ENV}`);
    console.log(`  Server:      http://localhost:${PORT}`);
    console.log(`  API:         http://localhost:${PORT}/api`);
    console.log(`  Health:      http://localhost:${PORT}/api/health`);
    if (isProd) {
      console.log(`  CORS:        ${corsOrigins.join(', ')}`);
    }
    console.log(`  SmartMatch:  daily at 06:00 (Asia/Jerusalem)`);
    console.log(`  Backup:      daily at 02:00 (Asia/Jerusalem)\n`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
