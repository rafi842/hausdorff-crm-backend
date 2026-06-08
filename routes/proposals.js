const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all, saveDb } = require('../database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

// All routes require auth
router.use(authMiddleware);

// GET / - list all proposals with contact names
router.get('/', (req, res) => {
  try {
    const proposals = all(`
      SELECT p.*,
             c.first_name || ' ' || c.last_name AS contact_name
      FROM proposals p
      LEFT JOIN contacts c ON c.id = p.contact_id
      ORDER BY p.created_at DESC
    `);
    res.json(proposals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:id - get single proposal
router.get('/:id', (req, res) => {
  try {
    const proposal = get(`
      SELECT p.*,
             c.first_name || ' ' || c.last_name AS contact_name
      FROM proposals p
      LEFT JOIN contacts c ON c.id = p.contact_id
      WHERE p.id = ?
    `, [req.params.id]);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    res.json(proposal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST / - create proposal
router.post('/', (req, res) => {
  try {
    const { template_type, deal_id, contact_id, property_id, title, data, status } = req.body;
    if (!template_type || !title || !data) {
      return res.status(400).json({ error: 'template_type, title and data are required' });
    }
    const id = uuidv4();
    const created_by = req.user?.name || req.user?.email || 'מנהל';
    run(
      `INSERT INTO proposals (id, template_type, deal_id, contact_id, property_id, title, data, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, template_type, deal_id || null, contact_id || null, property_id || null, title, data, status || 'draft', created_by]
    );
    const proposal = get('SELECT * FROM proposals WHERE id = ?', [id]);
    res.status(201).json(proposal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /:id - update proposal
router.put('/:id', (req, res) => {
  try {
    const existing = get('SELECT id FROM proposals WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Proposal not found' });
    const { template_type, deal_id, contact_id, property_id, title, data, status } = req.body;
    run(
      `UPDATE proposals SET
        template_type = ?, deal_id = ?, contact_id = ?, property_id = ?,
        title = ?, data = ?, status = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [template_type, deal_id || null, contact_id || null, property_id || null, title, data, status, req.params.id]
    );
    const proposal = get(`
      SELECT p.*, c.first_name || ' ' || c.last_name AS contact_name
      FROM proposals p
      LEFT JOIN contacts c ON c.id = p.contact_id
      WHERE p.id = ?
    `, [req.params.id]);
    res.json(proposal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /:id - delete proposal
router.delete('/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const existing = get('SELECT id FROM proposals WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Proposal not found' });
    run('DELETE FROM proposals WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/send - mark as sent
router.post('/:id/send', (req, res) => {
  try {
    const existing = get('SELECT * FROM proposals WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Proposal not found' });
    run(`UPDATE proposals SET status = 'sent', updated_at = datetime('now') WHERE id = ?`, [req.params.id]);
    // Add timeline event if deal_id exists
    if (existing.deal_id) {
      run(
        `INSERT INTO timeline (id, deal_id, contact_id, type, title, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          existing.deal_id,
          existing.contact_id || null,
          'document',
          `הצעת מחיר נשלחה: ${existing.title}`,
          `הצעת מחיר מסוג ${existing.template_type} נשלחה`,
          req.user?.name || 'מנהל',
        ]
      );
    }
    const proposal = get('SELECT * FROM proposals WHERE id = ?', [req.params.id]);
    res.json(proposal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
