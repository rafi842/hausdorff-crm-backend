const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware } = require('../middleware/auth');

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
    res.status(500).json({ error: err.message });
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
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    run(`INSERT INTO contacts (id,first_name,last_name,email,phone,type,contact_category,lead_status,source,company_id,budget_min,budget_max,preferred_areas,preferred_property_types,min_rooms,max_rooms,min_area,max_area,desired_yield,notes,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, first_name, last_name, email||'', phone||'', type||'קונה',
       contact_category||'contact', lead_status||'new',
       source||'ישיר', company_id||null,
       budget_min||0, budget_max||0,
       JSON.stringify(Array.isArray(preferred_areas) ? preferred_areas : []),
       JSON.stringify(Array.isArray(preferred_property_types) ? preferred_property_types : []),
       min_rooms||0, max_rooms||0, min_area||0, max_area||0,
       desired_yield||0, notes||'', status||'פעיל', now, now]);

    res.status(201).json(get(`
      SELECT c.*, comp.name as company_name FROM contacts c
      LEFT JOIN companies comp ON c.company_id = comp.id WHERE c.id=?`, [id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update
router.put('/:id', authMiddleware, (req, res) => {
  try {
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// DELETE
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    run('DELETE FROM contacts WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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

    const scored = properties.map(prop => {
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

      return { ...prop, match_score: score, match_reasons: reasons, is_match: score >= 80, is_yield_match: isYieldMatch };
    });

    scored.sort((a, b) => b.match_score - a.match_score);
    res.json(scored);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark lead as contacted - updates last_contacted_at
router.patch('/:id/mark-contacted', (req, res) => {
  try {
    const contact = get('SELECT * FROM contacts WHERE id = ?', [req.params.id]);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    run('UPDATE contacts SET last_contacted_at = ?, lead_status = CASE WHEN lead_status = ? THEN ? ELSE lead_status END, updated_at = datetime(?) WHERE id = ?',
      [new Date().toISOString(), 'new', 'contacted', 'now', req.params.id]);
    const updated = get('SELECT * FROM contacts WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
