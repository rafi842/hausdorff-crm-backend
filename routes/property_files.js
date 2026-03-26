const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/property-files/:id/download — download file
router.get('/:id/download', authMiddleware, (req, res) => {
  try {
    const file = get('SELECT * FROM property_files WHERE id=?', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const filePath = path.join(UPLOADS_DIR, file.file_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    res.setHeader('Content-Type', file.file_type || 'application/octet-stream');
    res.sendFile(filePath);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/property-files/:id — delete file
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const file = get('SELECT * FROM property_files WHERE id=?', [req.params.id]);
    if (file) {
      const filePath = path.join(UPLOADS_DIR, file.file_name);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      run('DELETE FROM property_files WHERE id=?', [req.params.id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
