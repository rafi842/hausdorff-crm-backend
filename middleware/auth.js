const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.error('FATAL: JWT_SECRET environment variable is required in production');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'crm-hausdorff-secret-2024';

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

  if (!token) {
    return res.status(401).json({ error: 'אין הרשאה - יש להתחבר למערכת' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'טוקן לא תקין או פג תוקף' });
  }
}

// Restrict a route to admins only. Must run AFTER authMiddleware (relies on req.user).
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'אין הרשאה - פעולה זו זמינה למנהל בלבד' });
  }
  next();
}

module.exports = { authMiddleware, adminOnly, JWT_SECRET };
