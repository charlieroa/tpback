-- Migración: Agregar columnas de geofence a la tabla users
-- Fecha: 2026-01-26
-- Descripción: Agrega columnas necesarias para el tracking de geolocalización y geofence

-- Agregar columnas de ubicación y geofence a la tabla users
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS current_lat DECIMAL(10,8),
ADD COLUMN IF NOT EXISTS current_lng DECIMAL(11,8),
ADD COLUMN IF NOT EXISTS is_inside_geofence BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS last_location_update TIMESTAMP;

-- Crear índices para mejorar el rendimiento de las consultas
CREATE INDEX IF NOT EXISTS idx_users_current_location ON users(current_lat, current_lng) WHERE current_lat IS NOT NULL AND current_lng IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_geofence_status ON users(is_inside_geofence) WHERE is_inside_geofence = true;
CREATE INDEX IF NOT EXISTS idx_users_last_location_update ON users(last_location_update) WHERE last_location_update IS NOT NULL;

-- Comentarios para documentación
COMMENT ON COLUMN users.current_lat IS 'Latitud actual del estilista';
COMMENT ON COLUMN users.current_lng IS 'Longitud actual del estilista';
COMMENT ON COLUMN users.is_inside_geofence IS 'Indica si el estilista está dentro de la geocerca';
COMMENT ON COLUMN users.last_location_update IS 'Última vez que se actualizó la ubicación del estilista';
