// En src/middleware/authMiddleware.js
const jwt = require('jsonwebtoken');

module.exports = function(req, res, next) {
    // Obtenemos el token del header 'Authorization', que viene como "Bearer <token>"
    const authHeader = req.header('Authorization');

    // Si no hay header, denegar
    if (!authHeader) {
        return res.status(401).json({ message: 'No hay token, autorización denegada.' });
    }

    try {
        // Separamos "Bearer" del token real
        const token = authHeader.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ message: 'Formato de token inválido.' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded.user;
        next();

    } catch (err) {
        res.status(401).json({ message: 'El token no es válido.' });
    }
};