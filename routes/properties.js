const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware } = require('../middleware/auth');

router.get('/', authMiddleware, (req, res) => {
  try {
    const { search, status, type, city, min_price, max_price, min_area, max_area, project_id, has_tenant } = req.query;
    let query = `SELECT p.*, proj.name as project_name FROM properties p LEFT JOIN projects proj ON p.project_id = proj.id WHERE 1=1`;
    const params = [];

    if (search) {
      query += ' AND (p.address LIKE ? OR p.city LIKE ? OR p.neighborhood LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (status) { query += ' AND p.status = ?'; params.push(status); }
    if (type) { query += ' AND p.type = ?'; params.push(type); }
    if (city) { query += ' AND p.city = ?'; params.push(city); }
    if (min_price) { query += ' AND p.price >= ?'; params.push(parseInt(min_price)); }
    if (max_price) { query += ' AND p.price <= ?'; params.push(parseInt(max_price)); }
    if (min_area) { query += ' AND p.area >= ?'; params.push(parseInt(min_area)); }
    if (max_area) { query += ' AND p.area <= ?'; params.push(parseInt(max_area)); }
    if (project_id) { query += ' AND p.project_id = ?'; params.push(project_id); }
    if (has_tenant !== undefined) { query += ' AND p.has_tenant = ?'; params.push(has_tenant === 'true' ? 1 : 0); }
    query += ' ORDER BY p.created_at DESC';

    res.json(all(query, params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', authMiddleware, (req, res) => {
  try {
    const property = get(`
      SELECT p.*, proj.name as project_name, c.name as company_name
      FROM properties p
      LEFT JOIN projects proj ON p.project_id = proj.id
      LEFT JOIN companies c ON proj.company_id = c.id
      WHERE p.id = ?
    `, [req.params.id]);
    if (!property) return res.status(404).json({ error: 'Property not found' });

    // Attach attachments
    const attachments = all(`SELECT * FROM attachments WHERE entity_type='property' AND entity_id=? ORDER BY created_at DESC`, [req.params.id]);
    const files = all(`SELECT * FROM property_files WHERE property_id=? ORDER BY uploaded_at DESC`, [req.params.id]);
    res.json({ ...property, attachments, property_files: files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', authMiddleware, (req, res) => {
  try {
    const id = uuidv4();
    const {
      project_id, address, city, neighborhood, type, status,
      price, area, rooms, floor, total_floors, parking, storage, balcony, elevator,
      description, land_use, zoning_plan, land_area_dunams,
      has_tenant, monthly_rent, annual_yield, tenant_name, lease_start_date, lease_end_date,
      exclusivity, deal_type
    } = req.body;
    const now = new Date().toISOString();
    run(`INSERT INTO properties (id,project_id,address,city,neighborhood,type,status,price,area,rooms,floor,total_floors,parking,storage,balcony,elevator,description,land_use,zoning_plan,land_area_dunams,has_tenant,monthly_rent,annual_yield,tenant_name,lease_start_date,lease_end_date,exclusivity,deal_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, project_id||null, address, city, neighborhood||'', type||'משרד', status||'זמין',
       price||0, area||0, rooms||0, floor||0, total_floors||0,
       parking||0, storage||0, balcony||0, elevator||0, description||'',
       land_use||'', zoning_plan||'', land_area_dunams||0,
       has_tenant ? 1 : 0, monthly_rent||0, annual_yield||0,
       tenant_name||'', lease_start_date||'', lease_end_date||'',
       exclusivity ? 1 : 0, deal_type||'מכירה', now, now]);
    res.status(201).json(get('SELECT * FROM properties WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', authMiddleware, (req, res) => {
  try {
    const {
      project_id, address, city, neighborhood, type, status,
      price, area, rooms, floor, total_floors, parking, storage, balcony, elevator,
      description, land_use, zoning_plan, land_area_dunams,
      has_tenant, monthly_rent, annual_yield, tenant_name, lease_start_date, lease_end_date,
      exclusivity, deal_type
    } = req.body;
    const now = new Date().toISOString();
    run(`UPDATE properties SET project_id=?,address=?,city=?,neighborhood=?,type=?,status=?,price=?,area=?,rooms=?,floor=?,total_floors=?,parking=?,storage=?,balcony=?,elevator=?,description=?,land_use=?,zoning_plan=?,land_area_dunams=?,has_tenant=?,monthly_rent=?,annual_yield=?,tenant_name=?,lease_start_date=?,lease_end_date=?,exclusivity=?,deal_type=?,updated_at=? WHERE id=?`,
      [project_id||null, address, city, neighborhood||'', type||'משרד', status||'זמין',
       price||0, area||0, rooms||0, floor||0, total_floors||0,
       parking||0, storage||0, balcony||0, elevator||0, description||'',
       land_use||'', zoning_plan||'', land_area_dunams||0,
       has_tenant ? 1 : 0, monthly_rent||0, annual_yield||0,
       tenant_name||'', lease_start_date||'', lease_end_date||'',
       exclusivity ? 1 : 0, deal_type||'מכירה', now, req.params.id]);
    res.json(get('SELECT * FROM properties WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', authMiddleware, (req, res) => {
  try {
    run('DELETE FROM properties WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
