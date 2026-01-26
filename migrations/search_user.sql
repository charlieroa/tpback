-- Script SQL para buscar usuario por nombre y teléfono
-- Ejecutar directamente en la base de datos PostgreSQL

-- Búsqueda por teléfono (múltiples formatos)
SELECT 
    id,
    first_name,
    last_name,
    phone,
    email,
    tenant_id,
    role_id,
    created_at,
    updated_at
FROM users
WHERE 
    -- Búsqueda exacta por teléfono
    phone = '3044180748'
    OR phone = '304 4180748'
    OR phone = '+573044180748'
    OR phone = '+57 304 4180748'
    OR phone = '573044180748'
    -- Búsqueda parcial por teléfono
    OR phone LIKE '%3044180748%'
    OR phone LIKE '%4180748%'
    OR phone LIKE '%180748%'
    OR REPLACE(REPLACE(phone, ' ', ''), '+', '') LIKE '%3044180748%'
    -- Búsqueda por nombre
    OR (LOWER(first_name) = LOWER('Fredy') AND LOWER(COALESCE(last_name, '')) = LOWER('Castellanos'))
    OR LOWER(first_name || ' ' || COALESCE(last_name, '')) LIKE LOWER('%Fredy Castellanos%')
    OR LOWER(first_name) LIKE LOWER('%Fredy%')
    OR LOWER(last_name) LIKE LOWER('%Castellanos%')
ORDER BY 
    -- Priorizar coincidencias exactas de teléfono
    CASE 
        WHEN phone = '3044180748' THEN 1
        WHEN phone = '304 4180748' THEN 2
        WHEN phone LIKE '%3044180748%' THEN 3
        ELSE 4
    END,
    -- Priorizar clientes (role_id = 4)
    CASE WHEN role_id = 4 THEN 0 ELSE 1 END,
    created_at DESC;

-- Si quieres buscar solo clientes (role_id = 4):
/*
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
WHERE role_id = 4
  AND (
    phone LIKE '%4180748%'
    OR LOWER(first_name) LIKE '%fredy%'
    OR LOWER(last_name) LIKE '%castellanos%'
  )
ORDER BY created_at DESC;
*/

-- Si quieres ver TODOS los usuarios con ese nombre (sin importar el teléfono):
/*
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
WHERE LOWER(first_name) LIKE '%fredy%'
   OR LOWER(last_name) LIKE '%castellanos%'
ORDER BY role_id, created_at DESC;
*/

-- Si quieres ver TODOS los usuarios con ese teléfono (sin importar el nombre):
/*
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
WHERE phone LIKE '%4180748%'
   OR REPLACE(REPLACE(phone, ' ', ''), '+', '') LIKE '%3044180748%'
ORDER BY created_at DESC;
*/
