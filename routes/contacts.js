const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { safeError } = require('../utils/errors');
const { fetchCorrespondence } = require('../services/gmail');

// GET all contacts (or leads)
router.get('/', authMiddleware, (req, res) => {
  try {
    const { search, type, source, company_id, contact_category, lead_status } = req.query;
    let query = `
      SELECT c.*, comp.name as company_name
      FROM contacts c
      LEFT JOIN companies comp ON c.company_id = comp.id
      WHERE 1=1
    `;
    const params = [];

    // Data scoping: non-admins see only their own records + legacy/unowned ones.
    if (req.user.role !== 'admin') {
      query += ` AND (c.owner_user_id = ? OR c.owner_user_id IS NULL OR c.owner_user_id = '')`;
      params.push(req.user.id);
    }

    if (search) {
      query += ` AND (c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (type) { query += ` AND c.type = ?`; params.push(type); }
    if (source) { query += ` AND c.source = ?`; params.push(source); }
    if (company_id) { query += ` AND c.company_id = ?`; params.push(company_id); }
    if (contact_category) { query += ` AND c.contact_category = ?`; params.push(contact_category); }
    if (lead_status) { query += ` AND c.lead_status = ?`; params.push(lead_status); }
    query += ` ORDER BY c.created_at DESC`;

    res.json(all(query, params));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// GET hot leads — new leads not contacted in >N hours
router.get('/hot-leads', authMiddleware, (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const leads = all(`
      SELECT c.* FROM contacts c
      WHERE c.status = 'חדש'
      AND (c.last_contacted_at IS NULL OR c.last_contacted_at = '')
      AND (julianday('now') - julianday(c.created_at)) * 24 >= ?
      ORDER BY c.created_at ASC
      LIMIT 20
    `, [hours]);
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// GET single contact
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const contact = get(`
      SELECT c.*, comp.name as company_name
      FROM contacts c
      LEFT JOIN companies comp ON c.company_id = comp.id
      WHERE c.id = ?
    `, [req.params.id]);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    // Non-admins may only view their own or legacy/unowned records.
    if (req.user.role !== 'admin' && contact.owner_user_id && contact.owner_user_id !== req.user.id) {
      return res.status(403).json({ error: 'אין הרשאה' });
    }
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// POST create
router.post('/', authMiddleware, (req, res) => {
  try {
    const id = uuidv4();
    const {
      first_name, last_name, email, phone, type, contact_category, lead_status,
      source, company_id,
      budget_min, budget_max, preferred_areas, preferred_property_types,
      min_rooms, max_rooms, min_area, max_area, desired_yield, notes, status
    } = req.body;

    const now = new Date().toISOString();
    // New records are owned by their creator (so non-admins see only their own).
    const owner_user_id = req.user.id;
    run(`INSERT INTO contacts (id,first_name,last_name,email,phone,type,contact_category,lead_status,source,company_id,budget_min,budget_max,preferred_areas,preferred_property_types,min_rooms,max_rooms,min_area,max_area,desired_yield,notes,status,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, first_name, last_name, email||'', phone||'', type||'קונה',
       contact_category||'contact', lead_status||'new',
       source||'ישיר', company_id||null,
       budget_min||0, budget_max||0,
       JSON.stringify(Array.isArray(preferred_areas) ? preferred_areas : []),
       JSON.stringify(Array.isArray(preferred_property_types) ? preferred_property_types : []),
       min_rooms||0, max_rooms||0, min_area||0, max_area||0,
       desired_yield||0, notes||'', status||'פעיל', owner_user_id, now, now]);

    res.status(201).json(get(`
      SELECT c.*, comp.name as company_name FROM contacts c
      LEFT JOIN companies comp ON c.company_id = comp.id WHERE c.id=?`, [id]));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// PUT update
router.put('/:id', authMiddleware, (req, res) => {
  try {
    // Non-admins may only edit their own or legacy/unowned records.
    if (req.user.role !== 'admin') {
      const existing = get('SELECT owner_user_id FROM contacts WHERE id = ?', [req.params.id]);
      if (existing && existing.owner_user_id && existing.owner_user_id !== req.user.id) {
        return res.status(403).json({ error: 'אין הרשאה' });
      }
    }
    const {
      first_name, last_name, email, phone, type, contact_category, lead_status,
      source, company_id,
      budget_min, budget_max, preferred_areas, preferred_property_types,
      min_rooms, max_rooms, min_area, max_area, desired_yield, notes, status
    } = req.body;
    const now = new Date().toISOString();
    run(`UPDATE contacts SET first_name=?,last_name=?,email=?,phone=?,type=?,contact_category=?,lead_status=?,source=?,company_id=?,budget_min=?,budget_max=?,preferred_areas=?,preferred_property_types=?,min_rooms=?,max_rooms=?,min_area=?,max_area=?,desired_yield=?,notes=?,status=?,updated_at=? WHERE id=?`,
      [first_name, last_name, email||'', phone||'', type||'קונה',
       contact_category||'contact', lead_status||'new',
       source||'ישיר', company_id||null,
       budget_min||0, budget_max||0,
       JSON.stringify(Array.isArray(preferred_areas) ? preferred_areas : []),
       JSON.stringify(Array.isArray(preferred_property_types) ? preferred_property_types : []),
       min_rooms||0, max_rooms||0, min_area||0, max_area||0,
       desired_yield||0, notes||'', status||'פעיל', now, req.params.id]);
    res.json(get(`
      SELECT c.*, comp.name as company_name FROM contacts c
      LEFT JOIN companies comp ON c.company_id = comp.id WHERE c.id=?`, [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// PATCH convert lead to contact
router.patch('/:id/convert', authMiddleware, (req, res) => {
  try {
    const now = new Date().toISOString();
    run(`UPDATE contacts SET contact_category='contact', lead_status='converted', updated_at=? WHERE id=?`,
      [now, req.params.id]);
    res.json(get(`
      SELECT c.*, comp.name as company_name FROM contacts c
      LEFT JOIN companies comp ON c.company_id = comp.id WHERE c.id=?`, [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// DELETE (admin only)
router.delete('/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    run('DELETE FROM contacts WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// GET contact deals
router.get('/:id/deals', authMiddleware, (req, res) => {
  try {
    const deals = all(`
      SELECT d.*, p.address as property_address
      FROM deals d
      LEFT JOIN properties p ON d.property_id = p.id
      WHERE d.contact_id = ?
      ORDER BY d.created_at DESC
    `, [req.params.id]);
    res.json(deals);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// POST smart match
router.post('/:id/smart-match', authMiddleware, (req, res) => {
  try {
    const contact = get('SELECT * FROM contacts WHERE id = ?', [req.params.id]);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const properties = all(`SELECT * FROM properties WHERE status = 'זמין'`);
    const preferredAreas = JSON.parse(contact.preferred_areas || '[]');
    const preferredTypes = JSON.parse(contact.preferred_property_types || '[]');

    const scored = properties.filter(prop => {
      // Pre-filter by deal type preference
      if (contact.preferred_deal_type && contact.preferred_deal_type !== 'שניהם' && prop.deal_type && prop.deal_type !== contact.preferred_deal_type) return false;
      // Pre-filter by contact type
      if (contact.type === 'שוכר פוטנציאלי' && prop.deal_type && prop.deal_type !== 'השכרה') return false;
      if (contact.type === 'רוכש פוטנציאלי' && prop.deal_type && prop.deal_type !== 'מכירה') return false;
      if (contact.type === 'משקיע' && !prop.annual_yield) return false;
      return true;
    }).map(prop => {
      let score = 0;
      const reasons = [];
      let isYieldMatch = false;

      // Location (40 pts)
      if (preferredAreas.length > 0 && preferredAreas.some(a => (prop.city||'').includes(a) || (prop.neighborhood||'').includes(a))) {
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

      // Type
      if (preferredTypes.length > 0 && preferredTypes.includes(prop.type)) {
        reasons.push('סוג נכס מתאים');
      }

      // Yield match
      if (contact.desired_yield > 0 && prop.annual_yield >= contact.desired_yield) {
        score = Math.max(score, 80);
        reasons.push(`תשואה ${prop.annual_yield}% >= ${contact.desired_yield}% המבוקש`);
        isYieldMatch = true;
      }

      // Parking (5 pts bonus)
      if (contact.min_parking > 0 && prop.parking >= contact.min_parking) {
        score += 5; reasons.push('חניות מתאימות');
      }

      // Floor preference (5 pts bonus)
      if (contact.preferred_floor === 'גבוהה' && prop.floor >= 5) { score += 5; reasons.push('קומה גבוהה'); }
      else if (contact.preferred_floor === 'נמוכה' && prop.floor > 0 && prop.floor <= 2) { score += 5; reasons.push('קומה נמוכה'); }
      else if (contact.preferred_floor === 'קרקע' && prop.floor === 0) { score += 5; reasons.push('קומת קרקע'); }

      // Deal type match
      if (contact.preferred_deal_type && contact.preferred_deal_type !== 'שניהם' && prop.deal_type === contact.preferred_deal_type) {
        reasons.push(`סוג עסקה: ${prop.deal_type}`);
      }

      return { ...prop, match_score: score, match_reasons: reasons, is_match: score >= 80, is_yield_match: isYieldMatch };
    });

    scored.sort((a, b) => b.match_score - a.match_score);
    res.json(scored);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// Mark lead as contacted - updates last_contacted_at
router.patch('/:id/mark-contacted', authMiddleware, (req, res) => {
  try {
    const contact = get('SELECT * FROM contacts WHERE id = ?', [req.params.id]);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    const now = new Date().toISOString();
    run('UPDATE contacts SET last_contacted_at = ?, lead_status = CASE WHEN lead_status = ? THEN ? ELSE lead_status END, updated_at = ? WHERE id = ?',
      [now, 'new', 'contacted', now, req.params.id]);
    const updated = get('SELECT * FROM contacts WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// GET /:id/emails — filed correspondence, newest first
router.get('/:id/emails', authMiddleware, (req, res) => {
  try {
    res.json(all(
      `SELECT * FROM email_messages WHERE contact_id = ? ORDER BY sent_at DESC`,
      [req.params.id]
    ));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// POST /:id/sync-emails — pull this contact's Gmail correspondence and file it.
// Idempotent: gmail_id is UNIQUE, so re-syncing only adds what's new.
router.post('/:id/sync-emails', authMiddleware, async (req, res) => {
  try {
    const contact = get('SELECT * FROM contacts WHERE id = ?', [req.params.id]);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (!contact.email) return res.status(400).json({ error: 'לאיש הקשר אין כתובת מייל' });

    const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user || !user.google_refresh_token) {
      return res.status(400).json({ error: 'חשבון Google לא מחובר. חבר אותו בהגדרות.' });
    }
    if (!(user.google_scopes || '').includes('gmail.readonly')) {
      return res.status(400).json({ error: 'חסרה הרשאת קריאת מיילים. התחבר מחדש ל-Google בהגדרות.' });
    }
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(400).json({ error: 'Google לא מוגדר בשרת' });
    }

    const { messages, capped } = await fetchCorrespondence({
      refreshToken: user.google_refresh_token,
      contactEmail: contact.email,
      userEmail: user.email,
    });

    let added = 0;
    for (const m of messages) {
      // INSERT OR IGNORE on the UNIQUE gmail_id makes re-sync cheap and safe.
      const result = run(
        `INSERT OR IGNORE INTO email_messages
           (id, gmail_id, thread_id, contact_id, company_id, direction, from_addr, to_addr, subject, snippet, body_text, sent_at, synced_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uuidv4(), m.gmail_id, m.thread_id, contact.id, contact.company_id || null,
         m.direction, m.from_addr, m.to_addr, m.subject, m.snippet, m.body_text, m.sent_at, req.user.id]
      );
      if (result && result.changes) added += result.changes;
    }
    if (capped) console.log(`[email-sync] contact ${contact.id}: hit the fetch cap; older mail not pulled this run`);

    res.json({
      added,
      total: get('SELECT COUNT(*) c FROM email_messages WHERE contact_id = ?', [contact.id]).c,
      capped,
      emails: all(`SELECT * FROM email_messages WHERE contact_id = ? ORDER BY sent_at DESC`, [contact.id]),
    });
  } catch (err) {
    const detail = err?.response?.data?.error?.message || err.message;
    res.status(500).json({ error: `סנכרון המיילים נכשל: ${detail}` });
  }
});

module.exports = router;
