const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { safeError } = require('../utils/errors');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Derive Content-Type from the stored file extension — never trust the
// client-supplied mimetype, which could be text/html/svg and be served inline
// as an XSS vector. Only extensions on the upload allow-list can appear here.
const CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
function safeContentType(fileName) {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.docx', '.doc', '.xlsx', '.xls'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// GET /api/property-files/list/:propertyId — list files for a property
router.get('/list/:propertyId', authMiddleware, (req, res) => {
  try {
    res.json(all('SELECT * FROM property_files WHERE property_id=? ORDER BY uploaded_at DESC', [req.params.propertyId]));
  } catch (err) { res.status(500).json({ error: safeError(err) }); }
});

// POST /api/property-files/:propertyId/upload — upload file
router.post('/:propertyId/upload', authMiddleware, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const id = uuidv4();
    const { category } = req.body;
    const now = new Date().toISOString();
    run(`INSERT INTO property_files (id,property_id,file_name,original_name,file_path,file_type,category,size,uploaded_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, req.params.propertyId, req.file.filename, req.file.originalname,
       `/uploads/${req.file.filename}`, req.file.mimetype,
       category || 'מסמכים נוספים', req.file.size, now]);
    res.status(201).json(get('SELECT * FROM property_files WHERE id=?', [id]));
  } catch (err) { res.status(500).json({ error: safeError(err) }); }
});

// GET /api/property-files/:id/preview — view file inline (no download)
router.get('/:id/preview', authMiddleware, (req, res) => {
  try {
    const file = get('SELECT * FROM property_files WHERE id=?', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const filePath = path.join(UPLOADS_DIR, file.file_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', safeContentType(file.file_name));
    res.sendFile(filePath);
  } catch (err) { res.status(500).json({ error: safeError(err) }); }
});

// GET /api/property-files/:id/download — download file
router.get('/:id/download', authMiddleware, (req, res) => {
  try {
    const file = get('SELECT * FROM property_files WHERE id=?', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const filePath = path.join(UPLOADS_DIR, file.file_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', safeContentType(file.file_name));
    res.sendFile(filePath);
  } catch (err) { res.status(500).json({ error: safeError(err) }); }
});

// DELETE /api/property-files/:id — delete file
router.delete('/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const file = get('SELECT * FROM property_files WHERE id=?', [req.params.id]);
    if (file) {
      const filePath = path.join(UPLOADS_DIR, file.file_name);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      run('DELETE FROM property_files WHERE id=?', [req.params.id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: safeError(err) }); }
});

module.exports = router;
