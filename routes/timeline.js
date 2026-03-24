const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware } = require('../middleware/auth');

router.get('/', authMiddleware, (req, res) => {
  try {
    const { deal_id, contact_id, limit } = req.query;
    let query = `
      SELECT t.*,
        d.title as deal_title,
        c.first_name || ' ' || c.last_name as contact_name
      FROM timeline t
      LEFT JOIN deals d ON t.deal_id = d.id
      LEFT JOIN contacts c ON t.contact_id = c.id
      WHERE 1=1
    `;
    const params = [];
    if (deal_id) { query += ' AND t.deal_id = ?'; params.push(deal_id); }
    if (contact_id) { query += ' AND t.contact_id = ?'; params.push(contact_id); }
    query += ' ORDER BY t.created_at DESC';
    if (limit) { query += ` LIMIT ${parseInt(limit)}`; }
    res.json(all(query, params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', authMiddleware, (req, res) => {
  try {
    const id = uuidv4();
    const { deal_id, contact_id, type, title, description, created_by } = req.body;
    const now = new Date().toISOString();
    run(`INSERT INTO timeline (id,deal_id,contact_id,type,title,description,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [id, deal_id||null, contact_id||null, type||'note', title, description||'', created_by||'מנהל', now]);
    res.status(201).json(get('SELECT * FROM timeline WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    run('DELETE FROM timeline WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
