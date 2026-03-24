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
      type TEXT DEFAULT 'קונה',
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
      type TEXT DEFAULT 'דירה',
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
  ];

  migrations.forEach(sql => {
    try { db.run(sql); } catch (e) { /* column already exists */ }
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
    [c1,'דוד','כהן','david.cohen@gmail.com','050-1234567','קונה','contact','new','אתר אינטרנט',null,1500000,2500000,JSON.stringify(['תל אביב','רמת גן']),JSON.stringify(['דירה']),3,4,80,120,0,'מחפש דירה עבור משפחה צעירה','פעיל'],
    [c2,'מיכל','לוי','michal.levi@hotmail.com','052-9876543','קונה','contact','new','המלצה',null,2000000,3500000,JSON.stringify(['הרצליה','רעננה']),JSON.stringify(['וילה']),5,7,150,250,0,'מעוניינת בנכס יוקרה','פעיל'],
    [c3,'אבי','ישראלי','avi.israeli@walla.com','054-5551234','משקיע','contact','new','פייסבוק',comp1,5000000,15000000,JSON.stringify(['תל אביב','גוש דן']),JSON.stringify(['מסחרי','משרדים']),0,0,200,1000,6.5,'משקיע מנוסה, מחפש תשואה 6.5%+','פעיל'],
    [c4,'רחל','גולדברג','rachel.goldberg@gmail.com','058-7778889','מוכר','contact','new','ישיר',null,0,0,JSON.stringify(['ירושלים']),JSON.stringify(['דירה']),0,0,0,0,0,'מוכרת דירה בירושלים','פעיל'],
    [c5,'יוסף','מזרחי','yosef.mizrahi@gmail.com','053-3334445','קונה','contact','new','גוגל',null,1200000,1800000,JSON.stringify(['פתח תקווה','ראש העין']),JSON.stringify(['דירה','דירת גן']),3,5,70,130,0,'זוג צעיר, רכישה ראשונה','פעיל'],
  ];
  contacts.forEach(c => run(`INSERT INTO contacts (id,first_name,last_name,email,phone,type,contact_category,lead_status,source,company_id,budget_min,budget_max,preferred_areas,preferred_property_types,min_rooms,max_rooms,min_area,max_area,desired_yield,notes,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, c));

  // ── Leads ─────────────────────────────────────────────────────────────────
  const l1=uuidv4(), l2=uuidv4(), l3=uuidv4();
  const leads = [
    [l1,'יעל','שמיר','yael@gmail.com','050-9988776','קונה','lead','new','פייסבוק',null,800000,1400000,JSON.stringify(['חיפה']),JSON.stringify(['דירה']),2,3,60,100,0,'ליד מפייסבוק - מחפשת דירה בחיפה','פעיל'],
    [l2,'מאיר','ברק','meir.barak@gmail.com','054-1122334','משקיע','lead','contacted','גוגל',null,2000000,5000000,JSON.stringify(['תל אביב']),JSON.stringify(['מסחרי']),0,0,100,300,5.0,'ליד מגוגל - משקיע מסחרי','פעיל'],
    [l3,'נועה','כץ','noa.katz@walla.com','052-5566778','קונה','lead','qualified','שיחה קרה',null,1800000,2800000,JSON.stringify(['רמת גן','גבעתיים']),JSON.stringify(['דירה','פנטהאוז']),3,5,90,150,0,'ליד שיחה קרה - מתעניינת','פעיל'],
  ];
  leads.forEach(l => run(`INSERT INTO contacts (id,first_name,last_name,email,phone,type,contact_category,lead_status,source,company_id,budget_min,budget_max,preferred_areas,preferred_property_types,min_rooms,max_rooms,min_area,max_area,desired_yield,notes,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, l));

  // ── Projects ───────────────────────────────────────────────────────────────
  const proj1=uuidv4(), proj2=uuidv4();
  run(`INSERT INTO projects (id,name,company_id,address,city,neighborhood,total_units,available_units,status,description,amenities,expected_completion) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [proj1,'מגדל הים',comp1,'הרברט סמואל 1','תל אביב','נמל תל אביב',120,45,'בבנייה','פרויקט יוקרה על קו הים',JSON.stringify(['בריכה','חדר כושר','לובי מפואר']),'2026-12-31']);
  run(`INSERT INTO projects (id,name,company_id,address,city,neighborhood,total_units,available_units,status,description,amenities,expected_completion) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [proj2,'שכונת הגן',comp2,'רחוב הגן 10','רעננה','מרכז העיר',60,22,'בשיווק','שכונת בוטיק ירוקה',JSON.stringify(['גינה משותפת','חניה']),'2025-06-30']);

  // ── Properties ─────────────────────────────────────────────────────────────
  const p1=uuidv4(),p2=uuidv4(),p3=uuidv4(),p4=uuidv4(),p5=uuidv4(),p6=uuidv4(),p7=uuidv4(),p8=uuidv4();
  // [id,proj,addr,city,nbhd,type,status,price,area,rooms,floor,totalFloors,parking,storage,balcony,elevator,desc,images,land_use,has_tenant,monthly_rent,annual_yield]
  const props = [
    [p1,proj1,'הרברט סמואל 1, דירה 12','תל אביב','נמל תל אביב','דירה','זמין',4500000,110,4,8,20,1,1,1,1,'דירת 4 חדרים עם נוף לים','[]','',0,0,0],
    [p2,proj1,'הרברט סמואל 1, דירה 35','תל אביב','נמל תל אביב','פנטהאוז','זמין',12000000,280,6,18,20,2,1,1,1,'פנטהאוז יוקרתי','[]','',0,0,0],
    [p3,proj2,'רחוב הגן 10, דירה 5','רעננה','מרכז העיר','דירת גן','זמין',2800000,130,5,1,6,2,1,1,1,'דירת גן פינתית','[]','',0,0,0],
    [p4,null,'רחוב דיזנגוף 150','תל אביב','דיזנגוף','דירה','זמין',3200000,95,3.5,4,8,1,0,1,1,'דירת 3.5 חדרים משופצת','[]','',0,0,0],
    [p5,null,'שדרות ירושלים 45','הרצליה','הרצליה פיתוח','וילה','זמין',8500000,350,7,0,2,3,1,1,0,'וילה מפוארת עם בריכה','[]','',0,0,0],
    [p6,null,'רחוב יפו 200','ירושלים','מרכז העיר','דירה','תפוס',2100000,85,3,3,5,0,1,0,0,'דירה מרווחת בלב ירושלים','[]','',0,0,0],
    [p7,null,'רחוב ביאליק 30','רמת גן','מרכז רמת גן','דירה','זמין',1950000,78,3,2,6,1,0,1,1,'דירה מטופחת ברמת גן','[]','',0,0,0],
    [p8,null,'שדרות מנחם בגין 100','תל אביב','הצפון הישן','משרדים','זמין',5800000,220,0,6,12,4,0,0,1,'משרדים מרכזיים - מושכר','[]','',1,35000,7.2],
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
    [d1,'דירת ים - דוד כהן',c1,p1,4,4500000,2.0,90000,addDays(30),null,'אתר אינטרנט','לקוח מתלהב','שרה לוי','גבוה'],
    [d2,'פנטהאוז - אבי ישראלי',c3,p2,6,12000000,1.5,180000,addDays(15),null,'המלצה','במשא ומתן','יוני כהן','גבוה'],
    [d3,'וילה הרצליה - מיכל לוי',c2,p5,5,8500000,2.0,170000,addDays(45),null,'המלצה','הצעה נשלחה','שרה לוי','גבוה'],
    [d4,'דירת גן רעננה - יוסף מזרחי',c5,p3,3,2800000,2.0,56000,addDays(60),null,'גוגל','קשר ראשוני','יוני כהן','בינוני'],
    [d5,'דיזנגוף - לקוח חדש',c1,p4,1,3200000,2.0,64000,addDays(90),null,'פייסבוק','פנייה נכנסת','שרה לוי','נמוך'],
    [d6,'משרדים בגין - אבי ישראלי',c3,p8,8,5800000,1.5,87000,addDays(-10),addDays(-10),'המלצה','עסקה נסגרה!','יוני כהן','גבוה'],
  ];
  deals.forEach(d => run(`INSERT INTO deals (id,title,contact_id,property_id,stage,value,commission_rate,commission_value,expected_close_date,actual_close_date,source,notes,assigned_to,priority) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, d));

  // ── Tasks ──────────────────────────────────────────────────────────────────
  function addDays2(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().split('T')[0];
  }
  const tasks = [
    [uuidv4(),'שיחת מעקב עם דוד כהן','לבדוק אם יש שאלות אחרי הסיור',d1,c1,'שרה לוי',addDays2(1),'10:00',0,'גבוה','שיחה'],
    [uuidv4(),'הכנת הסכם מכר - פנטהאוז','לתאם עם עורך דין',d2,c3,'יוני כהן',addDays2(3),'14:00',0,'גבוה','מסמך'],
    [uuidv4(),'שליחת חומרי שיווק - וילה','לשלוח קטלוג',d3,c2,'שרה לוי',addDays2(-2),'09:00',0,'בינוני','אימייל'],
    [uuidv4(),'סיור שני - דירת גן רעננה','לתאם עם כל המשפחה',d4,c5,'יוני כהן',addDays2(5),'11:30',0,'בינוני','פגישה'],
    [uuidv4(),'חזרה לפנייה מדיזנגוף','ליצור קשר ראשוני',d5,c1,'שרה לוי',addDays2(0),'16:00',0,'גבוה','שיחה'],
    [uuidv4(),'שליחת אישור עסקה - משרדים','מסמכי סיום',d6,c3,'יוני כהן',addDays2(-5),'',1,'גבוה','מסמך'],
    [uuidv4(),'בדיקת מימון - יוסף מזרחי','זכאות למשכנתא',d4,c5,'שרה לוי',addDays2(-1),'13:00',0,'גבוה','בדיקה'],
    [uuidv4(),'עדכון CRM - כל הנכסים','לעדכן סטטוסים',null,null,'יוני כהן',addDays2(2),'',0,'נמוך','משימה'],
    [uuidv4(),'פגישת מנהלים שבועית','עדכון עסקאות',null,null,'מנהל מערכת',addDays2(4),'09:00',0,'בינוני','פגישה'],
    [uuidv4(),'ניתוח שוק - תל אביב','הכנת דוח מחירים',null,null,'שרה לוי',addDays2(7),'',0,'נמוך','דוח'],
  ];
  tasks.forEach(t => run(`INSERT INTO tasks (id,title,description,deal_id,contact_id,assigned_to,due_date,task_time,completed,priority,type) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, t));

  // ── Timeline ───────────────────────────────────────────────────────────────
  const tlEvents = [
    [uuidv4(),d1,c1,'call','שיחת היכרות','שיחה ראשונית עם הלקוח','שרה לוי'],
    [uuidv4(),d1,c1,'visit','סיור בנכס','הלקוח ביקר בנכס','שרה לוי'],
    [uuidv4(),d2,c3,'meeting','פגישת מו"מ','פגישה לדיון על המחיר','יוני כהן'],
    [uuidv4(),d2,c3,'email','הצעה נגדית','הלקוח שלח הצעת מחיר','יוני כהן'],
    [uuidv4(),d6,c3,'close','עסקה נסגרה!','עסקת המשרדים נחתמה','יוני כהן'],
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
