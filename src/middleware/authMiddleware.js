// src/middleware/authMiddleware.js
const jwt = require('jsonwebtoken');

module.exports = function(req, res, next) {
  const authHeader = req.header('Authorization');
  if (!authHeader) {
    return res.status(401).json({ message: 'No hay token.' });
  }

  try {
    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Formato de token inválido.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // El payload del token debe incluir { user: { id, tenant_id, ... } }
    req.user = decoded.user;

    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Token no válido.' });
  }
};
