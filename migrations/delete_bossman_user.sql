-- Script para eliminar el usuario "BOSSMAN" de la base de datos
-- Fecha: 2026-01-26
-- Descripción: Elimina el usuario BOSSMAN para que se recree con el display name correcto

-- ⚠️ IMPORTANTE: Este script elimina el usuario y sus datos relacionados
-- Verificar antes de ejecutar

-- 1. Verificar el usuario antes de eliminar
SELECT 
    id,
    first_name,
    last_name,
    phone,
    email,
    tenant_id,
    role_id,
    created_at
FROM users
WHERE LOWER(first_name) = 'bossman'
   OR phone = '84366076207203'
ORDER BY created_at DESC;

-- 2. Verificar citas relacionadas (si las hay)
SELECT 
    a.id as appointment_id,
    a.start_time,
    a.status,
    u.first_name,
    u.phone
FROM appointments a
JOIN users u ON a.client_id = u.id
WHERE LOWER(u.first_name) = 'bossman'
   OR u.phone = '84366076207203';

-- 3. ELIMINAR citas relacionadas primero (si existen)
-- Descomentar las siguientes líneas para ejecutar:
/*
DELETE FROM appointments
WHERE client_id IN (
    SELECT id FROM users 
    WHERE LOWER(first_name) = 'bossman' 
       OR phone = '84366076207203'
);
*/

-- 4. ELIMINAR el usuario
-- Descomentar las siguientes líneas para ejecutar:
/*
DELETE FROM users
WHERE LOWER(first_name) = 'bossman'
   OR phone = '84366076207203';
*/

-- 5. Verificar que se eliminó
SELECT 
    COUNT(*) as usuarios_restantes
FROM users
WHERE LOWER(first_name) = 'bossman'
   OR phone = '84366076207203';
