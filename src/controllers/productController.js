// =========================================================
// File: src/controllers/productController.js (Versión Final + commission%)
// =========================================================
const db = require('../config/db');

// --- Helper: valida/normaliza porcentaje (0–100) o null ---
function parsePercentOrNull(input, fieldName = 'product_commission_percent') {
  if (input === undefined || input === null || input === '') return null;
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    const err = new Error(`${fieldName} debe estar entre 0 y 100.`);
    err.status = 400;
    throw err;
  }
  return Math.round(n * 100) / 100;
}

/**
 * Crea un nuevo producto.
 */
exports.createProduct = async (req, res) => {
  const {
    name,
    description,
    cost_price,
    sale_price,
    staff_price,
    stock = 0,
    category_id,
    audience_type = 'ambos',
    product_commission_percent, // NUEVO (opcional)
  } = req.body;
  const { tenant_id } = req.user;

  if (!name || sale_price === undefined) {
    return res.status(400).json({ error: 'Campos obligatorios: name, sale_price.' });
  }

  let pct = null;
  try {
    pct = parsePercentOrNull(product_commission_percent);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  try {
    const result = await db.query(
      `INSERT INTO products
         (tenant_id, name, description, cost_price, sale_price, staff_price, stock, category_id, audience_type, product_commission_percent)
       VALUES ($1,        $2,   $3,          $4,         $5,         $6,          $7,    $8,          $9,            $10)
       RETURNING *`,
      [tenant_id, name, description, cost_price, sale_price, staff_price, stock, category_id, audience_type, pct]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al crear el producto:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/**
 * Obtiene todos los productos activos de un tenant, con filtros opcionales.
 */
exports.getProductsByTenant = async (req, res) => {
  const { tenant_id } = req.user;
  const { audience } = req.query;

  try {
    let query = `
      SELECT p.*, c.name as category_name
      FROM products p
      LEFT JOIN product_categories c ON p.category_id = c.id
      WHERE p.tenant_id = $1 AND p.is_active = TRUE
    `;
    const params = [tenant_id];

    if (audience === 'cliente') {
      query += ` AND (p.audience_type = 'cliente' OR p.audience_type = 'ambos')`;
    } else if (audience === 'estilista') {
      query += ` AND (p.audience_type = 'estilista' OR p.audience_type = 'ambos')`;
    }

    query += ' ORDER BY p.name';

    const result = await db.query(query, params);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error al obtener productos:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/**
 * Obtiene un producto específico por su ID.
 */
exports.getProductById = async (req, res) => {
  const { id } = req.params;
  const { tenant_id } = req.user;
  try {
    const result = await db.query(
      `SELECT p.*, c.name as category_name
       FROM products p
       LEFT JOIN product_categories c ON p.category_id = c.id
       WHERE p.id = $1 AND p.tenant_id = $2 AND p.is_active = TRUE`,
      [id, tenant_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al obtener el producto:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/**
 * Actualiza un producto existente.
 */
exports.updateProduct = async (req, res) => {
  const { id } = req.params;
  const { tenant_id } = req.user;

  const {
    name,
    description,
    cost_price,
    sale_price,
    staff_price,
    stock,
    category_id,
    audience_type,
    product_commission_percent, // NUEVO (opcional)
  } = req.body;

  try {
    // Obtener producto actual
    const currentRes = await db.query('SELECT * FROM products WHERE id = $1 AND tenant_id = $2', [id, tenant_id]);
    if (currentRes.rows.length === 0) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }
    const current = currentRes.rows[0];

    // Validar % si viene
    let pct = undefined;
    try {
      if (product_commission_percent !== undefined) {
        pct = parsePercentOrNull(product_commission_percent);
      }
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }

    // Merge de campos
    const updated = {
      name: name ?? current.name,
      description: description ?? current.description,
      cost_price: cost_price ?? current.cost_price,
      sale_price: sale_price ?? current.sale_price,
      staff_price: staff_price ?? current.staff_price,
      stock: stock ?? current.stock,
      category_id: category_id ?? current.category_id,
      audience_type: audience_type ?? current.audience_type,
      product_commission_percent: pct === undefined ? current.product_commission_percent : pct,
    };

    const result = await db.query(
      `UPDATE products SET
          name = $1, description = $2, cost_price = $3, sale_price = $4, staff_price = $5,
          stock = $6, category_id = $7, audience_type = $8, product_commission_percent = $9, updated_at = NOW()
       WHERE id = $10 AND tenant_id = $11
       RETURNING *`,
      [
        updated.name, updated.description, updated.cost_price, updated.sale_price, updated.staff_price,
        updated.stock, updated.category_id, updated.audience_type, updated.product_commission_percent,
        id, tenant_id
      ]
    );

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al actualizar el producto:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/**
 * Elimina un producto (Borrado Lógico).
 */
exports.deleteProduct = async (req, res) => {
  const { id } = req.params;
  const { tenant_id } = req.user;
  try {
    const result = await db.query(
      'UPDATE products SET is_active = false, updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenant_id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar el producto:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/**
 * Permite ajustar el stock manualmente (compras, ajustes, etc.)
 */
exports.manageStock = async (req, res) => {
  const { productId } = req.params;
  const { type, quantity, description } = req.body;
  const { tenant_id, id: user_id } = req.user;

  const qty = parseInt(quantity, 10);
  if (isNaN(qty)) return res.status(400).json({ error: 'La cantidad debe ser un número.' });

  try {
    await db.query('BEGIN');

    let stockUpdateQuery;
    if (type === 'purchase' || type === 'adjustment-in') {
      stockUpdateQuery =
        'UPDATE products SET stock = stock + $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING stock';
    } else if (type === 'sale' || type === 'adjustment-out' || type === 'damaged') {
      stockUpdateQuery =
        'UPDATE products SET stock = stock - $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 AND stock >= $1 RETURNING stock';
    } else {
      throw new Error('Tipo de movimiento no válido.');
    }

    const productUpdateResult = await db.query(stockUpdateQuery, [Math.abs(qty), productId, tenant_id]);
    if (productUpdateResult.rowCount === 0) {
      throw new Error('Stock insuficiente o producto no encontrado.');
    }

    await db.query(
      `INSERT INTO inventory_movements (tenant_id, product_id, user_id, type, quantity, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenant_id, productId, user_id, type, qty, description]
    );

    await db.query('COMMIT');
    res.status(200).json({ message: 'Stock actualizado con éxito', newStock: productUpdateResult.rows[0].stock });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Error al gestionar el stock:', error.message);
    res.status(500).json({ error: `Error interno del servidor: ${error.message}` });
  }
};

/**
 * Actualiza la URL de la imagen de un producto después de que Multer la haya subido.
 */
exports.uploadProductImage = async (req, res) => {
  const { productId } = req.params;
  const { tenant_id } = req.user;

  if (!req.file) {
    return res.status(400).json({ error: 'No se recibió ningún archivo de imagen.' });
  }

  const imageUrl = `/uploads/products/${req.file.filename}`;

  try {
    const result = await db.query(
      'UPDATE products SET image_url = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING *',
      [imageUrl, productId, tenant_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Producto no encontrado o no pertenece a tu negocio.' });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al guardar la URL de la imagen del producto:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
};
