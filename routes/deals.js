const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const STAGE_NAMES = {
  1: 'פנייה נכנסת', 2: 'בדיקת היתכנות', 3: 'נוצר קשר ראשוני', 4: 'סיור בנכס',
  5: 'נשלחה הצעת מחיר', 6: 'משא ומתן', 7: 'הסכם לחתימה', 8: 'עסקה נסגרה', 9: 'עסקה אבדה'
};

router.get('/', authMiddleware, (req, res) => {
  try {
    const { search, stage, assigned_to, priority } = req.query;
    let query = `
      SELECT d.*,
        c.first_name || ' ' || c.last_name as contact_name,
        c.phone as contact_phone,
        p.address as property_address,
        p.city as property_city,
        p.type as property_type
      FROM deals d
      LEFT JOIN contacts c ON d.contact_id = c.id
      LEFT JOIN properties p ON d.property_id = p.id
      WHERE 1=1
    `;
    const params = [];
    if (search) {
      query += ' AND (d.title LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (stage) { query += ' AND d.stage = ?'; params.push(parseInt(stage)); }
    if (assigned_to) { query += ' AND d.assigned_to = ?'; params.push(assigned_to); }
    if (priority) { query += ' AND d.priority = ?'; params.push(priority); }
    query += ' ORDER BY d.updated_at DESC';
    res.json(all(query, params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', authMiddleware, (req, res) => {
  try {
    const deal = get(`
      SELECT d.*,
        c.first_name || ' ' || c.last_name as contact_name,
        c.phone as contact_phone,
        c.email as contact_email,
        p.address as property_address,
        p.city as property_city,
        p.neighborhood as property_neighborhood,
        p.type as property_type,
        p.area as property_area,
        p.rooms as property_rooms,
        p.floor as property_floor,
        p.price as property_price
      FROM deals d
      LEFT JOIN contacts c ON d.contact_id = c.id
      LEFT JOIN properties p ON d.property_id = p.id
      WHERE d.id = ?
    `, [req.params.id]);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    res.json(deal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', authMiddleware, (req, res) => {
  try {
    const id = uuidv4();
    const { title, contact_id, property_id, stage, value, commission_rate, expected_close_date, source, notes, assigned_to, priority } = req.body;
    const commRate = commission_rate || 2.0;
    const val = value || 0;
    const commValue = Math.round(val * commRate / 100);
    const now = new Date().toISOString();

    run(`INSERT INTO deals (id,title,contact_id,property_id,stage,value,commission_rate,commission_value,expected_close_date,source,notes,assigned_to,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, title, contact_id||null, property_id||null, stage||1, val, commRate, commValue, expected_close_date||null, source||'ישיר', notes||'', assigned_to||'מנהל', priority||'בינוני', now, now]);

    const tlId = uuidv4();
    run(`INSERT INTO timeline (id,deal_id,type,title,description,created_by,created_at) VALUES (?,?,?,?,?,?,?)`,
      [tlId, id, 'created', 'עסקה נוצרה', `עסקה חדשה בשלב "${STAGE_NAMES[stage||1]}"`, assigned_to||'מנהל', now]);

    res.status(201).json(get('SELECT * FROM deals WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', authMiddleware, (req, res) => {
  try {
    const existing = get('SELECT * FROM deals WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Deal not found' });

    const { title, contact_id, property_id, stage, value, commission_rate, expected_close_date, actual_close_date, source, notes, assigned_to, priority } = req.body;
    const commRate = commission_rate || 2.0;
    const val = value || 0;
    const commValue = Math.round(val * commRate / 100);
    const now = new Date().toISOString();

    run(`UPDATE deals SET title=?,contact_id=?,property_id=?,stage=?,value=?,commission_rate=?,commission_value=?,expected_close_date=?,actual_close_date=?,source=?,notes=?,assigned_to=?,priority=?,updated_at=? WHERE id=?`,
      [title, contact_id||null, property_id||null, stage||1, val, commRate, commValue, expected_close_date||null, actual_close_date||null, source||'ישיר', notes||'', assigned_to||'מנהל', priority||'בינוני', now, req.params.id]);

    if (existing.stage !== (stage||1)) {
      const tlId = uuidv4();
      run(`INSERT INTO timeline (id,deal_id,type,title,description,created_by,created_at) VALUES (?,?,?,?,?,?,?)`,
        [tlId, req.params.id, 'stage_change', 'שינוי שלב', `מ"${STAGE_NAMES[existing.stage]}" ל"${STAGE_NAMES[stage||1]}"`, assigned_to||'מנהל', now]);
    }

    res.json(get('SELECT * FROM deals WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/stage', authMiddleware, (req, res) => {
  try {
    const { stage, assigned_to } = req.body;
    const existing = get('SELECT * FROM deals WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Deal not found' });
    const now = new Date().toISOString();

    run(`UPDATE deals SET stage=?,updated_at=? WHERE id=?`, [stage, now, req.params.id]);

    const tlId = uuidv4();
    run(`INSERT INTO timeline (id,deal_id,type,title,description,created_by,created_at) VALUES (?,?,?,?,?,?,?)`,
      [tlId, req.params.id, 'stage_change', 'שינוי שלב', `מ"${STAGE_NAMES[existing.stage]}" ל"${STAGE_NAMES[stage]}"`, assigned_to||'מנהל', now]);

    res.json(get('SELECT * FROM deals WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', authMiddleware, (req, res) => {
  try {
    run('DELETE FROM timeline WHERE deal_id = ?', [req.params.id]);
    run('DELETE FROM tasks WHERE deal_id = ?', [req.params.id]);
    run('DELETE FROM deals WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/tasks', authMiddleware, (req, res) => {
  try {
    res.json(all('SELECT * FROM tasks WHERE deal_id = ? ORDER BY due_date ASC', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/timeline', authMiddleware, (req, res) => {
  try {
    res.json(all('SELECT * FROM timeline WHERE deal_id = ? ORDER BY created_at DESC', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/timeline', authMiddleware, (req, res) => {
  try {
    const id = uuidv4();
    const { type, title, description, created_by } = req.body;
    const now = new Date().toISOString();
    run(`INSERT INTO timeline (id,deal_id,type,title,description,created_by,created_at) VALUES (?,?,?,?,?,?,?)`,
      [id, req.params.id, type||'note', title, description||'', created_by||'מנהל', now]);
    res.status(201).json(get('SELECT * FROM timeline WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
