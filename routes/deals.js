const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { STAGE_NAMES, STAGE_SIGNED, STAGE_NEGOTIATION, OPEN_STAGES } = require('../utils/stages');

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

// At-risk deals: stuck 14+ days OR in negotiation (stage 5-6) with no recent activity (48h+)
router.get('/at-risk', authMiddleware, (req, res) => {
  try {
    const deals = all(`
      SELECT d.*,
        c.first_name || ' ' || c.last_name as contact_name,
        c.phone as contact_phone,
        p.address as property_address,
        p.city as property_city,
        CAST((julianday('now') - julianday(d.updated_at)) AS INTEGER) as days_stale,
        (SELECT MAX(created_at) FROM activities
         WHERE entity_type='deal' AND entity_id=d.id) as last_activity_at
      FROM deals d
      LEFT JOIN contacts c ON d.contact_id = c.id
      LEFT JOIN properties p ON d.property_id = p.id
      WHERE d.stage IN (${OPEN_STAGES.join(',')})
      AND (
        (julianday('now') - julianday(d.updated_at)) >= 14
        -- Contract negotiation only: silence costs most here. This read
        -- IN (5, 6) under the old 9-stage enum, but 6 is now חתום/signed and
        -- could never pass the filter above, so the branch was dead.
        OR (d.stage = ${STAGE_NEGOTIATION} AND (
          (SELECT MAX(created_at) FROM activities
           WHERE entity_type='deal' AND entity_id=d.id) IS NULL
          OR (julianday('now') - julianday(
            (SELECT MAX(created_at) FROM activities
             WHERE entity_type='deal' AND entity_id=d.id)
          )) >= 2
        ))
      )
      ORDER BY days_stale DESC
      LIMIT 20
    `);
    res.json(deals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /commissions — signed deals (stage 6). Commission = one month's rent of
// the leased unit (rent_per_sqm * area, else the deal value).
router.get('/commissions', authMiddleware, (req, res) => {
  try {
    const deals = all(`
      SELECT d.*, c.first_name || ' ' || c.last_name as contact_name, comp.name as chain_name,
             p.unit_number, p.rent_per_sqm, COALESCE(NULLIF(p.area_gross, 0), p.area) as unit_area, p.designated_category,
             proj.name as project_name
      FROM deals d
      LEFT JOIN contacts c ON d.contact_id = c.id
      LEFT JOIN companies comp ON c.company_id = comp.id
      LEFT JOIN properties p ON d.property_id = p.id
      LEFT JOIN projects proj ON p.project_id = proj.id
      WHERE d.stage = ${STAGE_SIGNED}
      ORDER BY COALESCE(d.actual_close_date, d.updated_at) DESC
    `);
    const rows = deals.map(d => {
      const monthlyRent = (d.rent_per_sqm && d.unit_area) ? d.rent_per_sqm * d.unit_area : (d.value || 0);
      return {
        id: d.id,
        chain_name: d.chain_name || d.contact_name || '—',
        project_name: d.project_name || '—',
        unit_number: d.unit_number || '—',
        designated_category: d.designated_category || '',
        monthly_rent: monthlyRent,
        commission: monthlyRent, // one month's rent
        close_date: d.actual_close_date || d.updated_at,
      };
    });
    const total = rows.reduce((s, r) => s + r.commission, 0);
    res.json({ rows, total, count: rows.length });
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

    // Signing IS closing, and dragging the card is the only way anyone marks a
    // deal won — no form anywhere writes actual_close_date. Without stamping it
    // here, every commission KPI that windows by close date (this week, this
    // month) stays at 0 forever no matter how many deals are signed.
    const isSigning = Number(stage) === STAGE_SIGNED && Number(existing.stage) !== STAGE_SIGNED;
    if (isSigning && !existing.actual_close_date) {
      run(`UPDATE deals SET stage=?,actual_close_date=?,updated_at=? WHERE id=?`,
        [stage, now.split('T')[0], now, req.params.id]);
    } else {
      run(`UPDATE deals SET stage=?,updated_at=? WHERE id=?`, [stage, now, req.params.id]);
    }

    const tlId = uuidv4();
    run(`INSERT INTO timeline (id,deal_id,type,title,description,created_by,created_at) VALUES (?,?,?,?,?,?,?)`,
      [tlId, req.params.id, 'stage_change', 'שינוי שלב', `מ"${STAGE_NAMES[existing.stage]}" ל"${STAGE_NAMES[stage]}"`, assigned_to||'מנהל', now]);

    res.json(get('SELECT * FROM deals WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const existing = get('SELECT id FROM deals WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Deal not found' });

    // sql.js has no transactions and no FK cascade, so every child has to be
    // swept by hand or it survives as an orphan pointing at a dead deal.
    run('DELETE FROM timeline WHERE deal_id = ?', [req.params.id]);
    run('DELETE FROM tasks WHERE deal_id = ?', [req.params.id]);
    run(`DELETE FROM activities WHERE entity_type = 'deal' AND entity_id = ?`, [req.params.id]);
    run('DELETE FROM meeting_attendees WHERE meeting_id IN (SELECT id FROM meetings WHERE deal_id = ?)', [req.params.id]);
    run('DELETE FROM meetings WHERE deal_id = ?', [req.params.id]);
    // Proposals outlive the deal — they belong to the client, and one may have
    // already gone out by email. Unlink instead of destroying the record.
    run(`UPDATE proposals SET deal_id = NULL WHERE deal_id = ?`, [req.params.id]);
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
