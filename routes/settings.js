const express = require('express');
const router = express.Router();
const multer = require('multer');
const { run, get, all } = require('../database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { safeError } = require('../utils/errors');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

// GET /api/settings — all app settings as a flat object
router.get('/', authMiddleware, (req, res) => {
  try {
    const rows = all('SELECT key, value FROM app_settings');
    const out = {};
    rows.forEach(r => { out[r.key] = r.value; });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
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
    res.status(500).json({ error: safeError(err) });
  }
});

// DELETE /api/settings/logo — remove the company logo
router.delete('/logo', authMiddleware, adminOnly, (req, res) => {
  try {
    run(`DELETE FROM app_settings WHERE key = 'company_logo'`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// Branded letterhead ("בלנק") — a full-page A4 background image (larger limit).
const uploadLetter = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
router.post('/letterhead', authMiddleware, adminOnly, uploadLetter.single('letterhead'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'לא הועלה קובץ' });
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!allowed.includes(req.file.mimetype)) return res.status(400).json({ error: 'סוג קובץ לא נתמך (PNG/JPG/WEBP)' });
    const dataUri = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
    const exists = get(`SELECT key FROM app_settings WHERE key = 'company_letterhead'`);
    if (exists) run(`UPDATE app_settings SET value = ?, updated_at = datetime('now') WHERE key = 'company_letterhead'`, [dataUri]);
    else run(`INSERT INTO app_settings (key, value) VALUES ('company_letterhead', ?)`, [dataUri]);
    res.json({ company_letterhead: dataUri });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});
router.delete('/letterhead', authMiddleware, adminOnly, (req, res) => {
  try {
    run(`DELETE FROM app_settings WHERE key = 'company_letterhead'`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

module.exports = router;
