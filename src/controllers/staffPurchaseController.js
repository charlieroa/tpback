const db = require('../config/db');

// --- Controlador para Compras del Personal ---

/**
 * Registra una nueva compra de productos por parte de un miembro del personal.
 * Esta operación es transaccional.
 */
exports.createPurchase = async (req, res) => {
    const { tenant_id } = req.user;
    // ¡NUEVO! Recibimos payment_terms_weeks del body de la petición.
    const { stylist_id, items, purchase_date, payment_terms_weeks } = req.body;

    // Validación básica de la entrada
    if (!stylist_id || !items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Se requiere el ID del estilista y una lista de productos.' });
    }

    const client = await db.getClient(); // Obtenemos un cliente de la pool para la transacción

    try {
        await client.query('BEGIN'); // Inicia la transacción

        // 1. Calcular el monto total de la compra
        const totalAmount = items.reduce((sum, item) => {
            return sum + (Number(item.price_at_sale) * Number(item.quantity));
        }, 0);

        if (totalAmount <= 0) {
            throw new Error("El monto total de la compra debe ser mayor a cero.");
        }

        // 2. Insertar el registro principal de la compra (¡AJUSTADO!)
        const purchaseResult = await client.query(
            // ¡AJUSTE! Añadimos la nueva columna a la consulta INSERT
            `INSERT INTO staff_purchases (tenant_id, stylist_id, total_amount, purchase_date, payment_terms_weeks)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            // ¡AJUSTE! Añadimos el nuevo valor, con 1 como default si no se envía
            [tenant_id, stylist_id, totalAmount, purchase_date || new Date(), payment_terms_weeks || 1]
        );
        const purchaseId = purchaseResult.rows[0].id;

        // 3. Insertar cada item de la compra y actualizar el stock del producto
        for (const item of items) {
            if (!item.product_id || !item.quantity || item.quantity <= 0 || !item.price_at_sale) {
                throw new Error('Cada item debe tener product_id, quantity y price_at_sale válidos.');
            }

            // Insertar el item en la tabla de detalles
            await client.query(
                `INSERT INTO staff_purchase_items (purchase_id, product_id, quantity, price_at_sale)
                 VALUES ($1, $2, $3, $4)`,
                [purchaseId, item.product_id, item.quantity, item.price_at_sale]
            );

            // Actualizar el stock del producto, asegurando que haya suficiente
            const stockUpdateResult = await client.query(
                `UPDATE products
                 SET stock = stock - $1
                 WHERE id = $2 AND tenant_id = $3 AND stock >= $1`,
                [item.quantity, item.product_id, tenant_id]
            );

            // Si rowCount es 0, significa que no había stock suficiente o el producto no existe
            if (stockUpdateResult.rowCount === 0) {
                throw new Error(`Stock insuficiente para el producto ID: ${item.product_id}.`);
            }
        }

        await client.query('COMMIT'); // Si todo salió bien, confirma la transacción
        res.status(201).json({ success: true, message: 'Compra registrada con éxito.', purchaseId });

    } catch (error) {
        await client.query('ROLLBACK'); // Si algo falla, deshace todos los cambios
        console.error('Error al registrar la compra de personal:', error);
        res.status(500).json({ error: 'Error interno del servidor', details: error.message });
    } finally {
        client.release(); // Libera al cliente de vuelta a la pool
    }
};

/**
 * Obtiene todas las compras de un estilista específico.
 */
exports.getPurchasesByStylist = async (req, res) => {
    const { tenant_id } = req.user;
    const { stylistId } = req.params;

    try {
        const result = await db.query(
            `SELECT * FROM staff_purchases 
             WHERE stylist_id = $1 AND tenant_id = $2 
             ORDER BY purchase_date DESC`,
            [stylistId, tenant_id]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error al obtener las compras del estilista:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

/**
 * Actualiza el estado de una compra (ej. para marcarla como 'deducido' por la nómina).
 */
exports.updatePurchaseStatus = async (req, res) => {
    const { tenant_id } = req.user;
    const { purchaseId } = req.params;
    const { status } = req.body;

    if (!status || !['pendiente', 'deducido', 'parcial'].includes(status)) {
        return res.status(400).json({ error: "El estado proporcionado no es válido. Use 'pendiente', 'deducido' o 'parcial'." });
    }

    try {
        const result = await db.query(
            `UPDATE staff_purchases 
             SET status = $1, updated_at = NOW() 
             WHERE id = $2 AND tenant_id = $3 
             RETURNING *`,
            [status, purchaseId, tenant_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Compra no encontrada.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error al actualizar el estado de la compra:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};