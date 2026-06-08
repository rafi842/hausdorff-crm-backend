const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

router.get('/', authMiddleware, (req, res) => {
  try {
    const { search, status } = req.query;
    let query = `SELECT p.*, c.name as company_name FROM projects p LEFT JOIN companies c ON p.company_id = c.id WHERE 1=1`;
    const params = [];
    if (search) {
      query += ' AND (p.name LIKE ? OR p.city LIKE ? OR p.neighborhood LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (status) { query += ' AND p.status = ?'; params.push(status); }
    query += ' ORDER BY p.created_at DESC';
    res.json(all(query, params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', authMiddleware, (req, res) => {
  try {
    const project = get(`SELECT p.*, c.name as company_name FROM projects p LEFT JOIN companies c ON p.company_id = c.id WHERE p.id = ?`, [req.params.id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/properties', (req, res) => {
  try {
    res.json(all('SELECT * FROM properties WHERE project_id = ? ORDER BY floor', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', authMiddleware, (req, res) => {
  try {
    const id = uuidv4();
    const { name, company_id, address, city, neighborhood, total_units, available_units, status, description, amenities, expected_completion } = req.body;
    const now = new Date().toISOString();
    run(`INSERT INTO projects (id,name,company_id,address,city,neighborhood,total_units,available_units,status,description,amenities,expected_completion,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, name, company_id||null, address||'', city||'', neighborhood||'', total_units||0, available_units||0, status||'בתכנון', description||'', JSON.stringify(amenities||[]), expected_completion||null, now, now]);
    res.status(201).json(get('SELECT * FROM projects WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', authMiddleware, (req, res) => {
  try {
    const { name, company_id, address, city, neighborhood, total_units, available_units, status, description, amenities, expected_completion } = req.body;
    const now = new Date().toISOString();
    run(`UPDATE projects SET name=?,company_id=?,address=?,city=?,neighborhood=?,total_units=?,available_units=?,status=?,description=?,amenities=?,expected_completion=?,updated_at=? WHERE id=?`,
      [name, company_id||null, address||'', city||'', neighborhood||'', total_units||0, available_units||0, status||'בתכנון', description||'', JSON.stringify(amenities||[]), expected_completion||null, now, req.params.id]);
    res.json(get('SELECT * FROM projects WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    run('DELETE FROM projects WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
