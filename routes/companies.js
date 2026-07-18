const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

router.get('/', authMiddleware, (req, res) => {
  try {
    const { search } = req.query;
    let query = 'SELECT * FROM companies WHERE 1=1';
    const params = [];
    if (search) {
      query += ' AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    query += ' ORDER BY name ASC';
    res.json(all(query, params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', authMiddleware, (req, res) => {
  try {
    const company = get('SELECT * FROM companies WHERE id = ?', [req.params.id]);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    res.json(company);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', authMiddleware, (req, res) => {
  try {
    const id = uuidv4();
    const { name, type, phone, email, address, website, notes,
      business_category, business_subcategory, branch_count,
      target_area_min, target_area_max, rent_budget_per_sqm, chain_status, expansion_notes } = req.body;
    const now = new Date().toISOString();
    run(`INSERT INTO companies (id,name,type,phone,email,address,website,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, name, type||'קבלן', phone||'', email||'', address||'', website||'', notes||'', now, now]);
    run(`UPDATE companies SET business_category=?,business_subcategory=?,branch_count=?,target_area_min=?,target_area_max=?,rent_budget_per_sqm=?,chain_status=?,expansion_notes=? WHERE id=?`,
      [business_category||'', business_subcategory||'', branch_count||0, target_area_min||0, target_area_max||0, rent_budget_per_sqm||0, chain_status||'פוטנציאלי', expansion_notes||'', id]);
    res.status(201).json(get('SELECT * FROM companies WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', authMiddleware, (req, res) => {
  try {
    const { name, type, phone, email, address, website, notes,
      business_category, business_subcategory, branch_count,
      target_area_min, target_area_max, rent_budget_per_sqm, chain_status, expansion_notes } = req.body;
    const now = new Date().toISOString();
    run(`UPDATE companies SET name=?,type=?,phone=?,email=?,address=?,website=?,notes=?,updated_at=? WHERE id=?`,
      [name, type||'קבלן', phone||'', email||'', address||'', website||'', notes||'', now, req.params.id]);
    run(`UPDATE companies SET business_category=?,business_subcategory=?,branch_count=?,target_area_min=?,target_area_max=?,rent_budget_per_sqm=?,chain_status=?,expansion_notes=? WHERE id=?`,
      [business_category||'', business_subcategory||'', branch_count||0, target_area_min||0, target_area_max||0, rent_budget_per_sqm||0, chain_status||'פוטנציאלי', expansion_notes||'', req.params.id]);
    res.json(get('SELECT * FROM companies WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    run('DELETE FROM companies WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:id/overview — everything the company (chain) card renders, in one request.
// The chain is the client and its contacts are the reps, so the card rolls up
// from the contacts: a deal, task or meeting belongs to the chain because it
// belongs to one of its people. This derives entirely from contacts.company_id —
// no company_id on deals/activities/meetings, so no schema change.
router.get('/:id/overview', authMiddleware, (req, res) => {
  try {
    const company = get('SELECT * FROM companies WHERE id = ?', [req.params.id]);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const cid = req.params.id;

    const contacts = all(
      `SELECT * FROM contacts WHERE company_id = ? ORDER BY first_name, last_name`, [cid]
    );

    // deals of any of the chain's contacts
    const deals = all(`
      SELECT d.*,
             c.first_name || ' ' || c.last_name AS contact_name,
             p.address AS property_address, p.city AS property_city
      FROM deals d
      LEFT JOIN contacts c ON d.contact_id = c.id
      LEFT JOIN properties p ON d.property_id = p.id
      WHERE d.contact_id IN (SELECT id FROM contacts WHERE company_id = ?)
      ORDER BY d.updated_at DESC
    `, [cid]);

    const tasks = all(`
      SELECT t.* FROM tasks t
      WHERE t.contact_id IN (SELECT id FROM contacts WHERE company_id = ?)
         OR t.deal_id IN (SELECT id FROM deals WHERE contact_id IN (SELECT id FROM contacts WHERE company_id = ?))
      ORDER BY t.completed ASC, t.due_date ASC
    `, [cid, cid]);

    const meetings = all(`
      SELECT m.*, c.first_name || ' ' || c.last_name AS contact_name
      FROM meetings m
      LEFT JOIN contacts c ON m.contact_id = c.id
      WHERE m.contact_id IN (SELECT id FROM contacts WHERE company_id = ?)
      ORDER BY m.start_datetime DESC
    `, [cid]);

    const stats = {
      contacts: contacts.length,
      open_deals: deals.filter(d => [1, 2, 3, 4, 5].includes(d.stage)).length,
      signed_deals: deals.filter(d => d.stage === 6).length,
      pipeline_value: deals.filter(d => [1, 2, 3, 4, 5].includes(d.stage)).reduce((s, d) => s + (d.value || 0), 0),
      open_tasks: tasks.filter(t => !t.completed).length,
    };

    res.json({ company, contacts, deals, tasks, meetings, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
