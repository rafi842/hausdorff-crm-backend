const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { run, get, all } = require('../database');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');

// ── Validation helper ─────────────────────────────────────────────────────────
function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }
  return null;
}

// Sanitize strings — strip HTML tags and trim
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '').trim();
}

// POST /api/auth/login
router.post('/login', [
  body('email').isEmail().withMessage('כתובת אימייל לא תקינה').normalizeEmail(),
  body('password').isLength({ min: 1 }).withMessage('יש להזין סיסמה'),
], (req, res) => {
  try {
    const err = validate(req, res);
    if (err) return;

    const { email, password } = req.body;

    const user = get('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (!user) {
      return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'שגיאת שרת פנימית' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  try {
    const user = get('SELECT id,name,email,role,created_at FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'משתמש לא נמצא' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת פנימית' });
  }
});

// GET /api/auth/agents - All authenticated users (lightweight: id + name only)
router.get('/agents', authMiddleware, (req, res) => {
  try {
    const agents = all('SELECT id, name FROM users ORDER BY name');
    res.json(agents);
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת פנימית' });
  }
});

// GET /api/auth/users - Admin only
router.get('/users', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'אין הרשאה' });
    }
    const users = all('SELECT id,name,email,role,created_at FROM users ORDER BY created_at');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת פנימית' });
  }
});

// POST /api/auth/users - Create user (admin only)
router.post('/users', authMiddleware, [
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('שם הוא שדה חובה (עד 100 תווים)'),
  body('email').isEmail().withMessage('כתובת אימייל לא תקינה').normalizeEmail(),
  body('password').isLength({ min: 6 }).withMessage('סיסמה חייבת להכיל לפחות 6 תווים'),
  body('role').optional().isIn(['admin', 'agent']).withMessage('תפקיד לא תקין'),
], (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'אין הרשאה' });
    }
    const err = validate(req, res);
    if (err) return;

    const { name, email, password, role } = req.body;
    const cleanName = sanitize(name);

    const existing = get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing) {
      return res.status(409).json({ error: 'אימייל כבר קיים במערכת' });
    }
    const id = uuidv4();
    const hash = bcrypt.hashSync(password, 10);
    const now = new Date().toISOString();
    run(`INSERT INTO users (id,name,email,password_hash,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      [id, cleanName, email.toLowerCase(), hash, role || 'agent', now, now]);
    res.status(201).json({ id, name: cleanName, email: email.toLowerCase(), role: role || 'agent', created_at: now });
  } catch (err) {
    console.error('[Auth] Create user error:', err.message);
    res.status(500).json({ error: 'שגיאת שרת פנימית' });
  }
});

// PUT /api/auth/users/:id - Update user
router.put('/users/:id', authMiddleware, [
  body('name').optional().trim().isLength({ min: 1, max: 100 }).withMessage('שם לא תקין'),
  body('email').optional().isEmail().withMessage('כתובת אימייל לא תקינה').normalizeEmail(),
  body('password').optional().isLength({ min: 6 }).withMessage('סיסמה חייבת להכיל לפחות 6 תווים'),
  body('role').optional().isIn(['admin', 'agent']).withMessage('תפקיד לא תקין'),
], (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.id !== req.params.id) {
      return res.status(403).json({ error: 'אין הרשאה' });
    }
    const err = validate(req, res);
    if (err) return;

    const { name, email, password, role } = req.body;
    const cleanName = sanitize(name);
    const now = new Date().toISOString();
    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      run(`UPDATE users SET name=?,email=?,password_hash=?,role=?,updated_at=? WHERE id=?`,
        [cleanName, email.toLowerCase(), hash, role || 'agent', now, req.params.id]);
    } else {
      run(`UPDATE users SET name=?,email=?,role=?,updated_at=? WHERE id=?`,
        [cleanName, email.toLowerCase(), role || 'agent', now, req.params.id]);
    }
    const user = get('SELECT id,name,email,role,created_at FROM users WHERE id=?', [req.params.id]);
    res.json(user);
  } catch (err) {
    console.error('[Auth] Update user error:', err.message);
    res.status(500).json({ error: 'שגיאת שרת פנימית' });
  }
});

// DELETE /api/auth/users/:id
router.delete('/users/:id', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'אין הרשאה' });
    }
    run('DELETE FROM users WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת פנימית' });
  }
});

module.exports = router;
