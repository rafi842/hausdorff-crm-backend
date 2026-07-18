const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { run, get, all } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { safeError } = require('../utils/errors');

// Floor-plan images are stored as data URIs (like the company logo). Plans are a
// handful per project, so the sql.js full-file writes stay acceptable.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// GET /api/floor-plans?project_id=... — all uploaded plans for a project.
router.get('/', authMiddleware, (req, res) => {
  try {
    const { project_id } = req.query;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    res.json(all('SELECT * FROM floor_plans WHERE project_id = ? ORDER BY created_at ASC', [project_id]));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/floor-plans — upload/replace the plan image for one project floor.
router.post('/', authMiddleware, upload.single('image'), (req, res) => {
  try {
    const { project_id, floor_label, width, height } = req.body;
    if (!req.file) return res.status(400).json({ error: 'לא הועלה קובץ' });
    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!allowed.includes(req.file.mimetype)) return res.status(400).json({ error: 'סוג קובץ לא נתמך (PNG/JPG/WEBP)' });
    const dataUri = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
    const fl = floor_label || '';
    const existing = get('SELECT id FROM floor_plans WHERE project_id = ? AND floor_label = ?', [project_id, fl]);
    if (existing) {
      run('UPDATE floor_plans SET image = ?, width = ?, height = ? WHERE id = ?', [dataUri, parseInt(width) || 0, parseInt(height) || 0, existing.id]);
    } else {
      run('INSERT INTO floor_plans (id,project_id,floor_label,image,width,height) VALUES (?,?,?,?,?,?)',
        [uuidv4(), project_id, fl, dataUri, parseInt(width) || 0, parseInt(height) || 0]);
    }
    res.json(get('SELECT * FROM floor_plans WHERE project_id = ? AND floor_label = ?', [project_id, fl]));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// DELETE /api/floor-plans/:id
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    run('DELETE FROM floor_plans WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

module.exports = router;
