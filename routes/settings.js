const express = require('express');
const router = express.Router();
const multer = require('multer');
const { run, get, all } = require('../database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

// GET /api/settings — all app settings as a flat object
router.get('/', authMiddleware, (req, res) => {
  try {
    const rows = all('SELECT key, value FROM app_settings');
    const out = {};
    rows.forEach(r => { out[r.key] = r.value; });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/logo — upload the company logo (stored as a data URI)
router.post('/logo', authMiddleware, adminOnly, upload.single('logo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'לא הועלה קובץ' });
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp', 'image/gif'];
    if (!allowed.includes(req.file.mimetype)) return res.status(400).json({ error: 'סוג קובץ לא נתמך (PNG/JPG/SVG/WEBP)' });
    const dataUri = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
    const exists = get(`SELECT key FROM app_settings WHERE key = 'company_logo'`);
    if (exists) run(`UPDATE app_settings SET value = ?, updated_at = datetime('now') WHERE key = 'company_logo'`, [dataUri]);
    else run(`INSERT INTO app_settings (key, value) VALUES ('company_logo', ?)`, [dataUri]);
    res.json({ company_logo: dataUri });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/settings/logo — remove the company logo
router.delete('/logo', authMiddleware, adminOnly, (req, res) => {
  try {
    run(`DELETE FROM app_settings WHERE key = 'company_logo'`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
