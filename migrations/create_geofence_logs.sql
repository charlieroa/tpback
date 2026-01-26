-- Tabla para registrar entrada/salida de estilistas en geocerca
-- Esta tabla se usa para tracking de asistencia basado en geolocalización

CREATE TABLE IF NOT EXISTS geofence_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stylist_id UUID NOT NULL,
    tenant_id UUID NOT NULL,
    event_type VARCHAR(10) NOT NULL CHECK (event_type IN ('entry', 'exit')),
    lat DECIMAL(10, 8),
    lng DECIMAL(11, 8),
    created_at TIMESTAMP DEFAULT NOW(),
    
    -- Índices para consultas rápidas
    CONSTRAINT fk_stylist FOREIGN KEY (stylist_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Índices para optimizar consultas
CREATE INDEX IF NOT EXISTS idx_geofence_logs_stylist ON geofence_logs(stylist_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_geofence_logs_date ON geofence_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_geofence_logs_tenant_date ON geofence_logs(tenant_id, created_at DESC);

-- Comentarios
COMMENT ON TABLE geofence_logs IS 'Registra eventos de entrada/salida de estilistas en la geocerca del salón';
COMMENT ON COLUMN geofence_logs.event_type IS 'Tipo de evento: entry (entrada) o exit (salida)';
COMMENT ON COLUMN geofence_logs.lat IS 'Latitud en el momento del evento';
COMMENT ON COLUMN geofence_logs.lng IS 'Longitud en el momento del evento';
