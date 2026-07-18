const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { safeError } = require('../utils/errors');

// GET attachments for an entity
router.get('/', authMiddleware, (req, res) => {
  try {
    const { entity_type, entity_id } = req.query;
    let query = 'SELECT * FROM attachments WHERE 1=1';
    const params = [];
    if (entity_type) { query += ' AND entity_type=?'; params.push(entity_type); }
    if (entity_id) { query += ' AND entity_id=?'; params.push(entity_id); }
    query += ' ORDER BY created_at DESC';
    res.json(all(query, params));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// POST create attachment record (frontend stores file as base64 or URL)
router.post('/', authMiddleware, (req, res) => {
  try {
    const { entity_type, entity_id, name, file_type, category, url, size } = req.body;
    const id = uuidv4();
    const now = new Date().toISOString();
    run(`INSERT INTO attachments (id,entity_type,entity_id,name,file_type,category,url,size,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, entity_type, entity_id, name, file_type||'', category||'אחר', url||'', size||0, req.user.name, now]);
    res.status(201).json(get('SELECT * FROM attachments WHERE id=?', [id]));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// DELETE attachment
router.delete('/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    run('DELETE FROM attachments WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

module.exports = router;
