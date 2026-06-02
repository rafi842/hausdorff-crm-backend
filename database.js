const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const DB_PATH = path.resolve(__dirname, process.env.DB_PATH || './crm.db');

let SQL;
let db;

async function initSQL() {
  if (SQL) return;
  const initSqlJs = require('sql.js');
  SQL = await initSqlJs();
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function getDb() {
  return db;
}

function run(query, params = []) {
  db.run(query, params);
  saveDb();
}

function get(query, params = []) {
  const stmt = db.prepare(query);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

function all(query, params = []) {
  const stmt = db.prepare(query);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

async function initializeDatabase() {
  await initSQL();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('Database loaded from file.');
  } else {
    db = new SQL.Database();
    console.log('New database created.');
  }

  db.run(`PRAGMA foreign_keys = ON;`);

  // ── Users ──────────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'agent',
      avatar TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Companies ──────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'קבלן',
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      address TEXT DEFAULT '',
      website TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Contacts ───────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      type TEXT DEFAULT 'רוכש פוטנציאלי',
      contact_category TEXT DEFAULT 'contact',
      lead_status TEXT DEFAULT 'new',
      source TEXT DEFAULT 'ישיר',
      company_id TEXT,
      budget_min INTEGER DEFAULT 0,
      budget_max INTEGER DEFAULT 0,
      preferred_areas TEXT DEFAULT '[]',
      preferred_property_types TEXT DEFAULT '[]',
      min_rooms INTEGER DEFAULT 0,
      max_rooms INTEGER DEFAULT 0,
      min_area INTEGER DEFAULT 0,
      max_area INTEGER DEFAULT 0,
      desired_yield REAL DEFAULT 0,
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'פעיל',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Projects ───────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      company_id TEXT,
      address TEXT DEFAULT '',
      city TEXT DEFAULT '',
      neighborhood TEXT DEFAULT '',
      total_units INTEGER DEFAULT 0,
      available_units INTEGER DEFAULT 0,
      status TEXT DEFAULT 'בבנייה',
      description TEXT DEFAULT '',
      amenities TEXT DEFAULT '[]',
      expected_completion TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Properties ─────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS properties (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      neighborhood TEXT DEFAULT '',
      type TEXT DEFAULT 'משרד',
      status TEXT DEFAULT 'זמין',
      price INTEGER DEFAULT 0,
      area INTEGER DEFAULT 0,
      rooms REAL DEFAULT 0,
      floor INTEGER DEFAULT 0,
      total_floors INTEGER DEFAULT 0,
      parking INTEGER DEFAULT 0,
      storage INTEGER DEFAULT 0,
      balcony INTEGER DEFAULT 0,
      elevator INTEGER DEFAULT 0,
      description TEXT DEFAULT '',
      images TEXT DEFAULT '[]',
      land_use TEXT DEFAULT '',
      has_tenant INTEGER DEFAULT 0,
      monthly_rent INTEGER DEFAULT 0,
      annual_yield REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Attachments ────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      name TEXT NOT NULL,
      file_type TEXT DEFAULT '',
      category TEXT DEFAULT 'אחר',
      url TEXT DEFAULT '',
      size INTEGER DEFAULT 0,
      uploaded_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Deals ──────────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      contact_id TEXT,
      property_id TEXT,
      stage INTEGER DEFAULT 1,
      value INTEGER DEFAULT 0,
      commission_rate REAL DEFAULT 2.0,
      commission_value INTEGER DEFAULT 0,
      expected_close_date TEXT,
      actual_close_date TEXT,
      source TEXT DEFAULT 'ישיר',
      notes TEXT DEFAULT '',
      assigned_to TEXT DEFAULT 'מנהל',
      priority TEXT DEFAULT 'בינוני',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Tasks ──────────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      deal_id TEXT,
      contact_id TEXT,
      assigned_to TEXT DEFAULT 'מנהל',
      due_date TEXT,
      task_time TEXT DEFAULT '',
      completed INTEGER DEFAULT 0,
      priority TEXT DEFAULT 'בינוני',
      type TEXT DEFAULT 'משימה',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Tasks migrations ──────────────────────────────────────────────────────
  const taskCols = all("PRAGMA table_info(tasks)").map(c => c.name);
  if (!taskCols.includes('postponed_reason')) {
    db.run("ALTER TABLE tasks ADD COLUMN postponed_reason TEXT DEFAULT ''");
  }
  if (!taskCols.includes('completion_notes')) {
    db.run("ALTER TABLE tasks ADD COLUMN completion_notes TEXT DEFAULT ''");
  }
  if (!taskCols.includes('postpone_count')) {
    db.run("ALTER TABLE tasks ADD COLUMN postpone_count INTEGER DEFAULT 0");
  }
  if (!taskCols.includes('assigned_to_id')) {
    db.run("ALTER TABLE tasks ADD COLUMN assigned_to_id TEXT DEFAULT NULL");
  }
  // Always try to populate NULL assigned_to_id from user names (runs every startup)
  db.run(`UPDATE tasks SET assigned_to_id = (
    SELECT u.id FROM users u WHERE u.name = tasks.assigned_to
  ) WHERE assigned_to_id IS NULL AND assigned_to IS NOT NULL`);
  if (!taskCols.includes('property_id')) {
    db.run("ALTER TABLE tasks ADD COLUMN property_id TEXT DEFAULT NULL");
  }
  if (!taskCols.includes('company_id')) {
    db.run("ALTER TABLE tasks ADD COLUMN company_id TEXT DEFAULT NULL");
  }

  // ── Task Participants (multi-agent shared tasks) ─────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS task_participants (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT DEFAULT 'participant',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(task_id, user_id)
    )
  `);
  // Seed existing owners into task_participants
  const tpCount = get("SELECT COUNT(*) as cnt FROM task_participants");
  if (tpCount && tpCount.cnt === 0) {
    db.run(`INSERT OR IGNORE INTO task_participants (id, task_id, user_id, role)
      SELECT hex(randomblob(16)), t.id, t.assigned_to_id, 'owner'
      FROM tasks t WHERE t.assigned_to_id IS NOT NULL`);
  }
  saveDb();

  // ── Timeline ───────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS timeline (
      id TEXT PRIMARY KEY,
      deal_id TEXT,
      contact_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_by TEXT DEFAULT 'מנהל',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Match Notifications ────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS match_notifications (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      score INTEGER DEFAULT 0,
      reasons TEXT DEFAULT '[]',
      is_yield_match INTEGER DEFAULT 0,
      seen INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Add status column to match_notifications if missing
  const mnCols = all("PRAGMA table_info(match_notifications)").map(c => c.name);
  if (!mnCols.includes('status')) {
    db.run("ALTER TABLE match_notifications ADD COLUMN status TEXT DEFAULT 'new'");
  }

  // ── Meetings ───────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      start_datetime TEXT NOT NULL,
      end_datetime TEXT NOT NULL,
      location TEXT DEFAULT '',
      contact_id TEXT,
      deal_id TEXT,
      google_event_id TEXT DEFAULT '',
      google_event_link TEXT DEFAULT '',
      status TEXT DEFAULT 'scheduled',
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS meeting_attendees (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT DEFAULT '',
      type TEXT DEFAULT 'client',
      rsvp_status TEXT DEFAULT 'pending',
      FOREIGN KEY (meeting_id) REFERENCES meetings(id)
    );
  `);

  // ── Proposals ──────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      template_type TEXT NOT NULL,
      deal_id TEXT,
      contact_id TEXT,
      property_id TEXT,
      title TEXT NOT NULL,
      data TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      created_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Property Files ──────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS property_files (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_type TEXT DEFAULT '',
      category TEXT DEFAULT 'מסמכים נוספים',
      size INTEGER DEFAULT 0,
      uploaded_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Activities ──────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      summary TEXT DEFAULT '',
      outcome TEXT DEFAULT '',
      next_action TEXT DEFAULT '',
      next_action_date TEXT,
      duration_minutes INTEGER DEFAULT 0,
      created_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Agent Goals ─────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_goals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      period_type TEXT DEFAULT 'monthly',
      year INTEGER NOT NULL,
      month INTEGER,
      commission_target INTEGER DEFAULT 0,
      calls_target INTEGER DEFAULT 0,
      proposals_target INTEGER DEFAULT 0,
      deals_target INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Webhook Logs ────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS webhook_logs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      payload TEXT DEFAULT '',
      status TEXT DEFAULT 'success',
      error_message TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Lead Assignment Rules ───────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS lead_assignment_rules (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      assigned_agent TEXT DEFAULT '',
      use_round_robin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── WhatsApp Logs ──────────────────────────────────────────────────────────
  // Every inbound/outbound WhatsApp message, used for dedup + audit + undo
  db.run(`
    CREATE TABLE IF NOT EXISTS whatsapp_logs (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      user_id TEXT,
      wa_phone TEXT NOT NULL,
      wa_message_id TEXT DEFAULT '',
      message_type TEXT NOT NULL,
      text_content TEXT DEFAULT '',
      media_url TEXT DEFAULT '',
      status TEXT DEFAULT 'received',
      error_message TEXT DEFAULT '',
      raw_payload TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── WhatsApp Pending Actions ───────────────────────────────────────────────
  // Proposed actions waiting for user approval (when LLM confidence < 90%)
  db.run(`
    CREATE TABLE IF NOT EXISTS whatsapp_pending_actions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      inbound_log_id TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      overall_confidence INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── WhatsApp Undo Log ──────────────────────────────────────────────────────
  // Inverse operations stored after auto-save, allow "בטל" within 1 hour
  db.run(`
    CREATE TABLE IF NOT EXISTS whatsapp_undo_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      inbound_log_id TEXT NOT NULL,
      reverse_ops_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  saveDb();

  // ── Run migrations for existing DB ─────────────────────────────────────────
  runMigrations();

  // ── Seed check ─────────────────────────────────────────────────────────────
  const countRow = get('SELECT COUNT(*) as c FROM contacts');
  if (countRow && countRow.c > 0) {
    // Ensure default users exist
    ensureDefaultUsers();
    console.log('Database already seeded.');
    return;
  }

  console.log('Seeding database with sample data...');
  seedDatabase();
}

function runMigrations() {
  // Add new columns to existing tables if they don't exist
  const migrations = [
    // contacts
    `ALTER TABLE contacts ADD COLUMN contact_category TEXT DEFAULT 'contact'`,
    `ALTER TABLE contacts ADD COLUMN lead_status TEXT DEFAULT 'new'`,
    `ALTER TABLE contacts ADD COLUMN desired_yield REAL DEFAULT 0`,
    // properties
    `ALTER TABLE properties ADD COLUMN land_use TEXT DEFAULT ''`,
    `ALTER TABLE properties ADD COLUMN has_tenant INTEGER DEFAULT 0`,
    `ALTER TABLE properties ADD COLUMN monthly_rent INTEGER DEFAULT 0`,
    `ALTER TABLE properties ADD COLUMN annual_yield REAL DEFAULT 0`,
    // tasks
    `ALTER TABLE tasks ADD COLUMN task_time TEXT DEFAULT ''`,
    // properties - new fields
    `ALTER TABLE properties ADD COLUMN zoning_plan TEXT DEFAULT ''`,
    `ALTER TABLE properties ADD COLUMN land_area_dunams REAL DEFAULT 0`,
    `ALTER TABLE properties ADD COLUMN tenant_name TEXT DEFAULT ''`,
    `ALTER TABLE properties ADD COLUMN lease_start_date TEXT DEFAULT ''`,
    `ALTER TABLE properties ADD COLUMN lease_end_date TEXT DEFAULT ''`,
    // Users table - Google Calendar tokens
    `ALTER TABLE users ADD COLUMN google_refresh_token TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN google_access_token TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN google_token_expiry TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN calendar_sync_enabled INTEGER DEFAULT 0`,
    // Contacts table - UTM tracking
    `ALTER TABLE contacts ADD COLUMN utm_source TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN utm_medium TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN utm_campaign TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN lead_source_detail TEXT DEFAULT ''`,
    // Properties - exclusivity and deal_type
    `ALTER TABLE properties ADD COLUMN exclusivity INTEGER DEFAULT 0`,
    `ALTER TABLE properties ADD COLUMN deal_type TEXT DEFAULT 'מכירה'`,
    // Contacts - last_contacted_at
    `ALTER TABLE contacts ADD COLUMN last_contacted_at TEXT DEFAULT ''`,
    // Properties - owner linking
    `ALTER TABLE properties ADD COLUMN owner_id TEXT DEFAULT NULL`,
    // Contacts - full profile for Smart Match
    `ALTER TABLE contacts ADD COLUMN preferred_deal_type TEXT DEFAULT 'שניהם'`,
    `ALTER TABLE contacts ADD COLUMN usage_purpose TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN desired_entry_date TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN min_parking INTEGER DEFAULT 0`,
    `ALTER TABLE contacts ADD COLUMN preferred_floor TEXT DEFAULT 'לא משנה'`,
    `ALTER TABLE contacts ADD COLUMN readiness_level TEXT DEFAULT 'מחפש פעיל'`,
    `ALTER TABLE contacts ADD COLUMN contact_role TEXT DEFAULT ''`,
    // Facebook Lead Ads tracking
    `ALTER TABLE contacts ADD COLUMN facebook_lead_id TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN facebook_form_id TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN facebook_form_name TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN facebook_ad_id TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN facebook_ad_name TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN facebook_adset_name TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN facebook_campaign_id TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN facebook_campaign_name TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN facebook_platform TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN facebook_lead_data TEXT DEFAULT ''`,
    // Users - WhatsApp linkage (E.164 phone, opt-in flag, opt-in timestamp)
    `ALTER TABLE users ADD COLUMN whatsapp_phone TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN whatsapp_enabled INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN whatsapp_opt_in_at TEXT DEFAULT ''`,
  ];

  migrations.forEach(sql => {
    try { db.run(sql); } catch (e) { /* column already exists */ }
  });

  // ── Data migrations: convert residential types to commercial ────────────
  const dataMigrations = [
    // Property types: map old residential → new commercial
    `UPDATE properties SET type = 'משרד' WHERE type IN ('דירה', 'משרדים')`,
    `UPDATE properties SET type = 'מרכז מסחרי' WHERE type = 'מסחרי'`,
    `UPDATE properties SET type = 'חנות' WHERE type = 'פנטהאוז'`,
    `UPDATE properties SET type = 'מרלו"ג' WHERE type IN ('וילה', "קוטג'")`,
    `UPDATE properties SET type = 'מבנה תעשייה' WHERE type = 'דירת גן'`,
    `UPDATE properties SET type = 'קרקע לבנייה' WHERE type = 'קרקע'`,
    // Contact types: map old → new
    `UPDATE contacts SET type = 'רוכש פוטנציאלי' WHERE type = 'קונה'`,
    `UPDATE contacts SET type = 'בעל נכס' WHERE type = 'מוכר'`,
    `UPDATE contacts SET type = 'שוכר פוטנציאלי' WHERE type = 'שוכר'`,
    `UPDATE contacts SET type = 'בעל נכס' WHERE type = 'משכיר'`,
    // Lead status: map old → new
    `UPDATE contacts SET lead_status = 'in_progress' WHERE lead_status = 'qualified'`,
    // Lead sources: map old → new
    `UPDATE contacts SET source = 'פרסום ממומן פייסבוק' WHERE source = 'פייסבוק'`,
    `UPDATE contacts SET source = 'פרסום ממומן גוגל' WHERE source = 'גוגל'`,
    `UPDATE contacts SET source = 'פה לאוזן / המלצה' WHERE source = 'המלצה'`,
    `UPDATE contacts SET source = 'פנייה ישירה' WHERE source IN ('ישיר', 'שיחה קרה')`,
    `UPDATE contacts SET source = 'מודעת נכס (יד2 / מדלן)' WHERE source IN ('יד2', 'מדלן')`,
    `UPDATE contacts SET source = 'אחר' WHERE source IN ('אתר אינטרנט', 'ייבוא CSV')`,
    `UPDATE contacts SET source = 'פנייה ישירה' WHERE source = 'שלט'`,
    // Deal sources
    `UPDATE deals SET source = 'פרסום ממומן פייסבוק' WHERE source = 'פייסבוק'`,
    `UPDATE deals SET source = 'פרסום ממומן גוגל' WHERE source = 'גוגל'`,
    `UPDATE deals SET source = 'פה לאוזן / המלצה' WHERE source = 'המלצה'`,
    `UPDATE deals SET source = 'פנייה ישירה' WHERE source = 'ישיר'`,
    `UPDATE deals SET source = 'מודעת נכס (יד2 / מדלן)' WHERE source IN ('יד2', 'מדלן')`,
    `UPDATE deals SET source = 'אחר' WHERE source = 'אתר אינטרנט'`,
  ];
  dataMigrations.forEach(sql => {
    try { db.run(sql); } catch (e) { /* ignore errors */ }
  });

  saveDb();
}

function ensureDefaultUsers() {
  const existing = get('SELECT id FROM users LIMIT 1');
  if (existing) return;

  const defaultUsers = [
    { id: uuidv4(), name: 'מנהל מערכת', email: 'admin@hausdorff.co.il', password: 'Admin123', role: 'admin' },
    { id: uuidv4(), name: 'רפי כהן', email: 'rafi@hausdorff.co.il', password: 'Rafi123', role: 'agent' },
    { id: uuidv4(), name: 'דוד לוי', email: 'david@hausdorff.co.il', password: 'David123', role: 'agent' },
  ];

  defaultUsers.forEach(u => {
    const hash = bcrypt.hashSync(u.password, 10);
    run(`INSERT OR IGNORE INTO users (id,name,email,password_hash,role) VALUES (?,?,?,?,?)`,
      [u.id, u.name, u.email, hash, u.role]);
  });
}

function seedDatabase() {
  // ── Default Users ──────────────────────────────────────────────────────────
  const defaultUsers = [
    { id: uuidv4(), name: 'מנהל מערכת', email: 'admin@hausdorff.co.il', password: 'Admin123', role: 'admin' },
    { id: uuidv4(), name: 'רפי כהן', email: 'rafi@hausdorff.co.il', password: 'Rafi123', role: 'agent' },
    { id: uuidv4(), name: 'דוד לוי', email: 'david@hausdorff.co.il', password: 'David123', role: 'agent' },
  ];
  defaultUsers.forEach(u => {
    const hash = bcrypt.hashSync(u.password, 10);
    run(`INSERT INTO users (id,name,email,password_hash,role) VALUES (?,?,?,?,?)`,
      [u.id, u.name, u.email, hash, u.role]);
  });

  // ── Companies ──────────────────────────────────────────────────────────────
  const comp1 = uuidv4(), comp2 = uuidv4(), comp3 = uuidv4();
  const companies = [
    [comp1, 'אמות השקעות', 'יזם', '03-6092222', 'info@amot.co.il', 'הארבעה 17, תל אביב', 'www.amot.co.il', 'יזם גדול בתחום הנדלן המסחרי'],
    [comp2, 'קבוצת אפריקה ישראל', 'קבלן', '03-7723000', 'info@africaisrael.com', 'קניון רמת אביב, תל אביב', 'www.africaisrael.com', 'קבוצת נדלן גדולה'],
    [comp3, 'שפיר הנדסה', 'קבלן', '04-8502500', 'info@shapir.co.il', 'יגאל אלון 114, תל אביב', 'www.shapir.co.il', 'חברת בנייה ותשתיות'],
  ];
  companies.forEach(c => run(`INSERT INTO companies (id,name,type,phone,email,address,website,notes) VALUES (?,?,?,?,?,?,?,?)`, c));

  // ── Contacts ───────────────────────────────────────────────────────────────
  const c1=uuidv4(), c2=uuidv4(), c3=uuidv4(), c4=uuidv4(), c5=uuidv4();
  // contact_category: 'contact' = existing client, 'lead' = prospect
  const contacts = [
    [c1,'אבי','ישראלי','avi.israeli@amot.co.il','054-5551234','משקיע','contact','new','פנייה ישירה',comp1,5000000,15000000,JSON.stringify(['תל אביב','גוש דן']),JSON.stringify(['משרד','מרלו"ג']),0,0,200,1000,6.5,'משקיע מנוסה, מחפש תשואה 6.5%+ על נכסים מסחריים','פעיל'],
    [c2,'מיכל','לוי','michal.levi@invest.co.il','052-9876543','רוכש פוטנציאלי','contact','new','פה לאוזן / המלצה',null,2000000,8000000,JSON.stringify(['הרצליה','רעננה']),JSON.stringify(['משרד','חנות']),0,0,150,500,0,'מחפשת משרדים להשקעה באזור השרון','פעיל'],
    [c3,'יוסף','מזרחי','yosef.m@realestate.co.il','053-3334445','בעל נכס','contact','new','פנייה ישירה',null,0,0,JSON.stringify(['פתח תקווה','ראש העין']),JSON.stringify(['מבנה תעשייה']),0,0,0,0,0,'בעל מבנה תעשייה בפתח תקווה, מעוניין למכור','פעיל'],
    [c4,'רחל','גולדברג','rachel.g@law.co.il','058-7778889','שוכר פוטנציאלי','contact','new','מודעת נכס (יד2 / מדלן)',null,0,50000,JSON.stringify(['ירושלים']),JSON.stringify(['משרד']),0,0,80,200,0,'עורכת דין מחפשת משרד בירושלים','פעיל'],
    [c5,'דני','שטרן','dani.stern@gmail.com','050-2223344','שותף מתווך','contact','new','פה לאוזן / המלצה',null,0,0,JSON.stringify(['תל אביב','חיפה']),JSON.stringify([]),0,0,0,0,0,'מתווך מסחרי, שותף לעסקאות באזור חיפה','פעיל'],
  ];
  contacts.forEach(c => run(`INSERT INTO contacts (id,first_name,last_name,email,phone,type,contact_category,lead_status,source,company_id,budget_min,budget_max,preferred_areas,preferred_property_types,min_rooms,max_rooms,min_area,max_area,desired_yield,notes,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, c));

  // ── Leads ─────────────────────────────────────────────────────────────────
  const l1=uuidv4(), l2=uuidv4(), l3=uuidv4();
  const leads = [
    [l1,'יעל','שמיר','yael@techco.com','050-9988776','רוכש פוטנציאלי','lead','new','פרסום ממומן פייסבוק',null,1000000,3000000,JSON.stringify(['חיפה']),JSON.stringify(['משרד']),0,0,60,200,0,'ליד מפייסבוק - מחפשת משרד לחברת הייטק','פעיל'],
    [l2,'מאיר','ברק','meir.barak@fund.co.il','054-1122334','משקיע','lead','contacted','פרסום ממומן גוגל',null,5000000,20000000,JSON.stringify(['תל אביב']),JSON.stringify(['מרכז מסחרי','חנות']),0,0,300,2000,5.0,'ליד מגוגל - קרן השקעות מחפשת מרכז מסחרי','פעיל'],
    [l3,'נועה','כץ','noa.katz@logistics.com','052-5566778','שוכר פוטנציאלי','lead','new','שלט על נכס',null,0,80000,JSON.stringify(['ראשון לציון','לוד']),JSON.stringify(['מרלו"ג']),0,0,500,2000,0,'ליד משלט - חברת לוגיסטיקה מחפשת מרלו"ג','פעיל'],
  ];
  leads.forEach(l => run(`INSERT INTO contacts (id,first_name,last_name,email,phone,type,contact_category,lead_status,source,company_id,budget_min,budget_max,preferred_areas,preferred_property_types,min_rooms,max_rooms,min_area,max_area,desired_yield,notes,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, l));

  // ── Projects ───────────────────────────────────────────────────────────────
  const proj1=uuidv4(), proj2=uuidv4();
  run(`INSERT INTO projects (id,name,company_id,address,city,neighborhood,total_units,available_units,status,description,amenities,expected_completion) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [proj1,'מגדל עזריאלי החדש',comp1,'דרך מנחם בגין','תל אביב','מרכז העיר',80,25,'בבנייה','מגדל משרדים חדש 40 קומות',JSON.stringify(['חניון','לובי מפואר','מעליות מהירות']),'2027-06-30']);
  run(`INSERT INTO projects (id,name,company_id,address,city,neighborhood,total_units,available_units,status,description,amenities,expected_completion) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [proj2,'פארק הייטק הרצליה',comp2,'אבא אבן 10','הרצליה','הרצליה פיתוח',40,15,'בשיווק','פארק משרדים ירוק בהרצליה פיתוח',JSON.stringify(['חניון תת-קרקעי','מסעדות','כושר']),'2026-12-31']);

  // ── Properties ─────────────────────────────────────────────────────────────
  const p1=uuidv4(),p2=uuidv4(),p3=uuidv4(),p4=uuidv4(),p5=uuidv4(),p6=uuidv4(),p7=uuidv4(),p8=uuidv4();
  // [id,proj,addr,city,nbhd,type,status,price,area,rooms,floor,totalFloors,parking,storage,balcony,elevator,desc,images,land_use,has_tenant,monthly_rent,annual_yield]
  const props = [
    [p1,null,'מנחם בגין 100, קומה 6','תל אביב','הצפון הישן','משרד','זמין',5800000,220,0,6,12,4,0,0,1,'קומת משרדים שלמה, מושכר לחברת הייטק','[]','',1,38000,7.9],
    [p2,null,'דרך השלום 50','תל אביב','מרכז העיר','חנות','זמין',3200000,85,0,0,2,0,0,0,0,'חנות רחוב במיקום מרכזי, חזית 12 מטר','[]','',1,18000,6.8],
    [p3,null,'אזור תעשייה צפוני','חיפה','מפרץ חיפה','מרלו"ג','זמין',12000000,2500,0,0,1,10,0,0,0,'מרכז לוגיסטי עם רמפות פריקה, גובה 10 מטר','[]','',1,75000,7.5],
    [p4,null,'הרצל 40','ירושלים','מרכז העיר','חנות','זמין',4500000,120,0,0,3,1,0,0,0,'שטח מסחרי בלב ירושלים, מתאים למסעדה','[]','',0,0,0],
    [p5,null,'שדרות רוטשילד 22','תל אביב','לב העיר','משרד','תפוס',15000000,450,0,3,8,6,0,0,1,'בניין משרדים בוטיק, מושכר במלואו','[]','',1,95000,7.6],
    [p6,null,'פארק תעשייה קיסריה','חדרה','קיסריה','מבנה תעשייה','זמין',8500000,1200,0,0,1,5,0,0,0,'מבנה תעשייה חדש, תשתיות חשמל תלת-פאזי','[]','תעשייה',0,0,0],
    [p7,null,'שטח בצומת גלילות','רמת השרון','גלילות','קרקע לבנייה','זמין',25000000,5000,0,0,0,0,0,0,0,'קרקע 5 דונם, ייעוד מסחרי, תב"ע מאושרת','[]','מסחר',0,0,0],
    [p8,null,'קניון הנגב','באר שבע','מרכז העיר','מרכז מסחרי','זמין',35000000,3500,0,0,3,50,0,0,0,'מרכז מסחרי עם 45 חנויות, 85% תפוסה','[]','',1,250000,8.6],
  ];
  props.forEach(p => run(`INSERT INTO properties (id,project_id,address,city,neighborhood,type,status,price,area,rooms,floor,total_floors,parking,storage,balcony,elevator,description,images,land_use,has_tenant,monthly_rent,annual_yield) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, p));

  // ── Deals ──────────────────────────────────────────────────────────────────
  function addDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().split('T')[0];
  }
  const d1=uuidv4(),d2=uuidv4(),d3=uuidv4(),d4=uuidv4(),d5=uuidv4(),d6=uuidv4();
  const deals = [
    [d1,'משרדים בגין - אבי ישראלי',c1,p1,6,5800000,1.5,87000,addDays(15),null,'פנייה ישירה','במשא ומתן על מחיר','רפי כהן','גבוה'],
    [d2,'מרלו"ג חיפה - מאיר ברק',c3,p3,4,12000000,1.0,120000,addDays(45),null,'פרסום ממומן גוגל','סיור בנכס בוצע','דוד לוי','גבוה'],
    [d3,'חנות ירושלים - רחל גולדברג',c4,p4,5,4500000,2.0,90000,addDays(30),null,'מודעת נכס (יד2 / מדלן)','הצעה נשלחה','רפי כהן','בינוני'],
    [d4,'קרקע גלילות - אבי ישראלי',c1,p7,2,25000000,1.0,250000,addDays(90),null,'פנייה ישירה','בבדיקת היתכנות','דוד לוי','גבוה'],
    [d5,'חנות רוטשילד - ליד חדש',c2,p2,1,3200000,2.0,64000,addDays(60),null,'פה לאוזן / המלצה','פנייה נכנסת','רפי כהן','נמוך'],
    [d6,'מרכז מסחרי באר שבע - אבי ישראלי',c1,p8,8,35000000,0.75,262500,addDays(-10),addDays(-10),'פנייה ישירה','עסקה נסגרה!','דוד לוי','גבוה'],
  ];
  deals.forEach(d => run(`INSERT INTO deals (id,title,contact_id,property_id,stage,value,commission_rate,commission_value,expected_close_date,actual_close_date,source,notes,assigned_to,priority) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, d));

  // ── Tasks ──────────────────────────────────────────────────────────────────
  function addDays2(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().split('T')[0];
  }
  const tasks = [
    [uuidv4(),'שיחת מעקב - משרדים בגין','לבדוק סטטוס משא ומתן',d1,c1,'רפי כהן',addDays2(1),'10:00',0,'גבוה','שיחה'],
    [uuidv4(),'הכנת חוזה - מרלו"ג חיפה','לתאם עם עורך דין',d2,c3,'דוד לוי',addDays2(3),'14:00',0,'גבוה','מסמך'],
    [uuidv4(),'שליחת שמאות - חנות ירושלים','לשלוח דוח שמאי',d3,c4,'רפי כהן',addDays2(-2),'09:00',0,'בינוני','אימייל'],
    [uuidv4(),'סיור בקרקע גלילות','לתאם סיור עם המשקיע',d4,c1,'דוד לוי',addDays2(5),'11:30',0,'בינוני','פגישה'],
    [uuidv4(),'חזרה לפנייה - חנות רוטשילד','ליצור קשר ראשוני',d5,c2,'רפי כהן',addDays2(0),'16:00',0,'גבוה','שיחה'],
    [uuidv4(),'שליחת אישור עסקה - מרכז מסחרי','מסמכי סיום',d6,c1,'דוד לוי',addDays2(-5),'',1,'גבוה','מסמך'],
    [uuidv4(),'בדיקת תב"ע - קרקע גלילות','בירור ייעוד ואפשרויות בנייה',d4,c1,'רפי כהן',addDays2(-1),'13:00',0,'גבוה','בדיקה'],
    [uuidv4(),'עדכון CRM - כל הנכסים','לעדכן סטטוסי נכסים מסחריים',null,null,'דוד לוי',addDays2(2),'',0,'נמוך','משימה'],
    [uuidv4(),'פגישת מנהלים שבועית','סיכום עסקאות מסחריות',null,null,'מנהל מערכת',addDays2(4),'09:00',0,'בינוני','פגישה'],
    [uuidv4(),'ניתוח שוק - נדל"ן מסחרי ת"א','הכנת דוח תשואות',null,null,'רפי כהן',addDays2(7),'',0,'נמוך','דוח'],
  ];
  tasks.forEach(t => run(`INSERT INTO tasks (id,title,description,deal_id,contact_id,assigned_to,due_date,task_time,completed,priority,type) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, t));

  // ── Timeline ───────────────────────────────────────────────────────────────
  const tlEvents = [
    [uuidv4(),d1,c1,'call','שיחת היכרות','שיחה ראשונית על משרדים בבגין','רפי כהן'],
    [uuidv4(),d1,c1,'visit','סיור בנכס','סיור במשרדים - הלקוח מרוצה','רפי כהן'],
    [uuidv4(),d2,c3,'meeting','פגישת מו"מ','פגישה לדיון על תנאי מכירה','דוד לוי'],
    [uuidv4(),d3,c4,'email','הצעת מחיר','נשלחה הצעת מחיר לחנות בירושלים','רפי כהן'],
    [uuidv4(),d6,c1,'close','עסקה נסגרה!','עסקת המרכז המסחרי נחתמה','דוד לוי'],
  ];
  tlEvents.forEach(t => run(`INSERT INTO timeline (id,deal_id,contact_id,type,title,description,created_by) VALUES (?,?,?,?,?,?,?)`, t));

  // ── Sample Goals ────────────────────────────────────────────────────────
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  // Find agent user ids
  const rafiUser = get(`SELECT id FROM users WHERE email = 'rafi@hausdorff.co.il'`);
  const davidUser = get(`SELECT id FROM users WHERE email = 'david@hausdorff.co.il'`);

  if (rafiUser) {
    const existingGoal = get(`SELECT id FROM agent_goals WHERE user_id = ? AND year = ? AND month = ?`, [rafiUser.id, currentYear, currentMonth]);
    if (!existingGoal) {
      run(`INSERT INTO agent_goals (id, user_id, period_type, year, month, commission_target, calls_target, proposals_target, deals_target, created_at) VALUES (?, ?, 'monthly', ?, ?, 15000, 50, 5, 2, ?)`,
        [require('uuid').v4(), rafiUser.id, currentYear, currentMonth, new Date().toISOString()]);
    }
  }
  if (davidUser) {
    const existingGoal = get(`SELECT id FROM agent_goals WHERE user_id = ? AND year = ? AND month = ?`, [davidUser.id, currentYear, currentMonth]);
    if (!existingGoal) {
      run(`INSERT INTO agent_goals (id, user_id, period_type, year, month, commission_target, calls_target, proposals_target, deals_target, created_at) VALUES (?, ?, 'monthly', ?, ?, 20000, 40, 4, 3, ?)`,
        [require('uuid').v4(), davidUser.id, currentYear, currentMonth, new Date().toISOString()]);
    }
  }

  saveDb();
  console.log('Database seeded successfully!');
}

module.exports = { getDb, initializeDatabase, run, get, all, saveDb };
