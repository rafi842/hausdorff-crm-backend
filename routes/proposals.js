const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { run, get, all, saveDb } = require('../database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

// All routes require auth
router.use(authMiddleware);

// The quote PDF is printed by the agent's own browser and uploaded here, because
// the quote is set in Tahoma — a Windows font that no Linux server has. Rendering
// it server-side would silently substitute a different face and reflow the page
// breaks. Files go to disk, never into the DB: sql.js rewrites the entire DB file
// on every mutation, so a few hundred KB of base64 per proposal would be reread
// and rewritten on every unrelated write.
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, uuidv4() + '.pdf')
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB — matches property_files
  fileFilter: (req, file, cb) => {
    cb(null, path.extname(file.originalname).toLowerCase() === '.pdf');
  }
});

// GET / - list proposals (optionally filtered by contact_id or company_id)
router.get('/', (req, res) => {
  try {
    const { contact_id, company_id } = req.query;
    let where = '';
    const params = [];
    if (contact_id) { where = 'WHERE p.contact_id = ?'; params.push(contact_id); }
    else if (company_id) { where = 'WHERE p.company_id = ?'; params.push(company_id); }
    const proposals = all(`
      SELECT p.*,
             c.first_name || ' ' || c.last_name AS contact_name,
             comp.name AS company_name
      FROM proposals p
      LEFT JOIN contacts c ON c.id = p.contact_id
      LEFT JOIN companies comp ON comp.id = p.company_id
      ${where}
      ORDER BY p.created_at DESC
    `, params);
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
    const { template_type, deal_id, contact_id, company_id, property_id, title, data, status } = req.body;
    if (!template_type || !title || !data) {
      return res.status(400).json({ error: 'template_type, title and data are required' });
    }
    const id = uuidv4();
    const created_by = req.user?.name || req.user?.email || 'מנהל';
    run(
      `INSERT INTO proposals (id, template_type, deal_id, contact_id, company_id, property_id, title, data, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, template_type, deal_id || null, contact_id || null, company_id || null, property_id || null, title, data, status || 'draft', created_by]
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
    const { template_type, deal_id, contact_id, company_id, property_id, title, data, status } = req.body;
    run(
      `UPDATE proposals SET
        template_type = ?, deal_id = ?, contact_id = ?, company_id = ?, property_id = ?,
        title = ?, data = ?, status = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [template_type, deal_id || null, contact_id || null, company_id || null, property_id || null, title, data, status, req.params.id]
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

// ── Quote PDF: upload / fetch / remove ──────────────────────────────────────

// Browsers send multipart filenames as UTF-8, but busboy (under multer) decodes
// them as latin1, so "הצעת מחיר.pdf" arrives mojibake and would reach the client
// as the attachment's filename. Re-read the bytes as what they actually are.
function decodeFilename(name) {
  if (!name) return '';
  const fixed = Buffer.from(name, 'latin1').toString('utf8');
  // A pure-ASCII name is already correct, and re-decoding can only damage it.
  return /[^\x00-\x7F]/.test(name) ? fixed : name;
}

// Deleting the row's file is best-effort: a missing or already-removed file must
// not block replacing or detaching it.
function unlinkQuiet(fileName) {
  if (!fileName) return;
  try { fs.unlinkSync(path.join(UPLOADS_DIR, fileName)); } catch (e) { /* already gone */ }
}

// POST /:id/pdf - attach the printed quote (replaces any previous file)
router.post('/:id/pdf', upload.single('file'), (req, res) => {
  try {
    const existing = get('SELECT * FROM proposals WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Proposal not found' });
    if (!req.file) return res.status(400).json({ error: 'נדרש קובץ PDF' });

    unlinkQuiet(existing.pdf_file_name);
    run(
      `UPDATE proposals SET pdf_file_name=?, pdf_original_name=?, pdf_size=?,
         pdf_uploaded_at=datetime('now'), updated_at=datetime('now') WHERE id=?`,
      [req.file.filename, decodeFilename(req.file.originalname), req.file.size, req.params.id]
    );
    res.json(get('SELECT * FROM proposals WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:id/pdf - stream the attached PDF back for preview/download
router.get('/:id/pdf', (req, res) => {
  try {
    const proposal = get('SELECT * FROM proposals WHERE id = ?', [req.params.id]);
    if (!proposal || !proposal.pdf_file_name) return res.status(404).json({ error: 'אין קובץ מצורף' });
    const filePath = path.join(UPLOADS_DIR, proposal.pdf_file_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'הקובץ לא נמצא בשרת' });
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /:id/pdf - detach the PDF
router.delete('/:id/pdf', (req, res) => {
  try {
    const existing = get('SELECT * FROM proposals WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Proposal not found' });
    unlinkQuiet(existing.pdf_file_name);
    run(
      `UPDATE proposals SET pdf_file_name='', pdf_original_name='', pdf_size=0,
         pdf_uploaded_at='', updated_at=datetime('now') WHERE id=?`,
      [req.params.id]
    );
    res.json(get('SELECT * FROM proposals WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Send by Gmail ───────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A plain-text part carries no direction, so Gmail lays Hebrew out left-to-right
// and strands the punctuation. Only an HTML part can say dir="rtl".
function buildHtmlBody(text, signatureHtml) {
  const body = escapeHtml(text || '').replace(/\r?\n/g, '<br>');
  const sig = signatureHtml ? `<br><br>${signatureHtml}` : '';
  return `<div dir="rtl" style="text-align:right;font-family:Arial,Helvetica,sans-serif;font-size:14px;">${body}${sig}</div>`;
}

// Gmail attaches signatures in its own compose UI only — messages sent through the
// API get nothing. Pull the agent's real one so CRM mail matches what they send by
// hand. Best-effort: a proposal that sends without a signature beats one that fails.
async function fetchGmailSignature(gmail) {
  try {
    const { data } = await gmail.users.settings.sendAs.list({ userId: 'me' });
    const list = data.sendAs || [];
    const primary = list.find(s => s.isDefault) || list.find(s => s.isPrimary) || list[0];
    return primary?.signature || '';
  } catch (e) {
    return '';
  }
}

// Record the send on every card it belongs to.
//
// The client card reads `activities`; `timeline` is written from nine places and
// read by no UI at all, which is why sending a proposal used to leave no trace
// anywhere the agent looks. Write `activities` — and keep mirroring `timeline` the
// way POST /activities does, so the dashboard's recent-activity feed still sees it.
//
// One row per entity, because ActivityTimeline queries by entity: without the
// contact row the send is invisible on the client card, which is the whole point.
function logProposalSent(proposal, recipients, user) {
  const subject = `הצעת מחיר נשלחה במייל: ${proposal.title}`;
  const summary = `נשלחה אל ${recipients}`;

  const targets = [];
  if (proposal.contact_id) targets.push(['contact', proposal.contact_id]);
  if (proposal.deal_id) targets.push(['deal', proposal.deal_id]);

  targets.forEach(([entityType, entityId]) => {
    run(
      `INSERT INTO activities (id, entity_type, entity_id, activity_type, subject, summary, created_by)
       VALUES (?, ?, ?, 'proposal_sent', ?, ?, ?)`,
      [uuidv4(), entityType, entityId, subject, summary, user?.id || '']
    );
  });

  run(
    `INSERT INTO timeline (id, deal_id, contact_id, type, title, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), proposal.deal_id || null, proposal.contact_id || null, 'proposal_sent', subject, summary, user?.name || 'מנהל']
  );
}

// The client sees this as the attachment's name, so derive it from the proposal
// rather than from whatever the browser called the print-out (Chrome names it
// after the page title, which made every quote arrive as "HAUSDORFF CRM.pdf").
function attachmentName(proposal) {
  const base = (proposal.title || 'הצעת מחיר').replace(/[\\/:*?"<>|]/g, '-').trim();
  return `${base}.pdf`;
}

// POST /:id/send-email - email the proposal from the agent's own Gmail
router.post('/:id/send-email', async (req, res) => {
  try {
    const proposal = get('SELECT * FROM proposals WHERE id = ?', [req.params.id]);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

    const { to, cc, subject, body } = req.body;
    const toList = (Array.isArray(to) ? to : [to]).filter(Boolean).map(s => String(s).trim());
    const ccList = (Array.isArray(cc) ? cc : cc ? [cc] : []).filter(Boolean).map(s => String(s).trim());

    if (!toList.length) return res.status(400).json({ error: 'נדרש נמען' });
    const bad = [...toList, ...ccList].find(e => !EMAIL_RE.test(e));
    if (bad) return res.status(400).json({ error: `כתובת מייל לא תקינה: ${bad}` });
    if (!subject || !String(subject).trim()) return res.status(400).json({ error: 'נדרש נושא' });

    const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user || !user.google_refresh_token) {
      return res.status(400).json({ error: 'חשבון Google לא מחובר. חבר אותו בהגדרות.' });
    }
    if (!(user.google_scopes || '').includes('gmail.send')) {
      return res.status(400).json({ error: 'חסרה הרשאת שליחת מייל. התחבר מחדש ל-Google בהגדרות.' });
    }
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(400).json({ error: 'Google לא מוגדר בשרת' });
    }

    // The attachment is optional: a covering note with no quote is still a valid
    // thing to send, and blocking on it would be surprising.
    const attachments = [];
    if (proposal.pdf_file_name) {
      const filePath = path.join(UPLOADS_DIR, proposal.pdf_file_name);
      if (!fs.existsSync(filePath)) {
        return res.status(400).json({ error: 'הקובץ המצורף לא נמצא בשרת. העלה אותו מחדש.' });
      }
      attachments.push({
        filename: attachmentName(proposal),
        path: filePath,
        contentType: 'application/pdf'
      });
    }

    const { google } = require('googleapis');
    const MailComposer = require('nodemailer/lib/mail-composer');

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI ||
        `${(process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '')}/api/calendar/callback`
    );
    oauth2Client.setCredentials({ refresh_token: user.google_refresh_token });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const signature = await fetchGmailSignature(gmail);

    // Let nodemailer build the MIME (RFC 2047 encoding for the Hebrew subject and
    // filename, base64 for the attachment); Gmail only wants the finished message.
    // Both parts go out: text for clients that refuse HTML, html for direction.
    const mime = await new MailComposer({
      from: user.email,
      to: toList.join(', '),
      cc: ccList.length ? ccList.join(', ') : undefined,
      subject: String(subject).trim(),
      text: body || '',
      html: buildHtmlBody(body, signature),
      attachments
    }).compile().build();

    const sent = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: mime.toString('base64url') }
    });

    const recipients = toList.join(', ');

    // The mail is gone the moment Gmail accepts it. Nothing below may throw a 500,
    // or the agent will retry a send that already happened and the client gets the
    // proposal twice.
    try {
      run(
        `UPDATE proposals SET status='sent', sent_to=?, sent_at=datetime('now'), updated_at=datetime('now') WHERE id=?`,
        [recipients, req.params.id]
      );
      logProposalSent(proposal, recipients, req.user);
    } catch (e) {
      console.error('proposal sent but logging failed:', e.message);
    }

    res.json({
      success: true,
      messageId: sent.data.id,
      sent_to: recipients,
      proposal: get('SELECT * FROM proposals WHERE id = ?', [req.params.id])
    });
  } catch (err) {
    // Google's errors arrive nested and are opaque on their own; surface the
    // useful part so a missing scope or a rejected recipient is diagnosable.
    const detail = err?.response?.data?.error?.message || err.message;
    res.status(500).json({ error: `שליחת המייל נכשלה: ${detail}` });
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
