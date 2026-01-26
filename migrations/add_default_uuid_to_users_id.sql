-- Migración: Agregar DEFAULT gen_random_uuid() a la columna id de users
-- Fecha: 2026-01-26
-- Descripción: Agrega un valor por defecto a la columna id para evitar errores al crear usuarios sin especificar ID

-- Verificar si la extensión uuid-ossp está habilitada (necesaria para gen_random_uuid en PostgreSQL < 13)
-- O usar gen_random_uuid() que viene nativo en PostgreSQL 13+
DO $$
BEGIN
    -- Intentar habilitar la extensión si no existe (para PostgreSQL < 13)
    BEGIN
        CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    EXCEPTION WHEN OTHERS THEN
        -- Si falla, probablemente ya existe o no es necesario (PostgreSQL 13+)
        NULL;
    END;
END $$;

-- Agregar DEFAULT a la columna id si no lo tiene
DO $$
BEGIN
    -- Verificar si la columna id ya tiene un DEFAULT
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'users' 
          AND column_name = 'id'
          AND column_default IS NOT NULL
    ) THEN
        -- Intentar usar gen_random_uuid() (PostgreSQL 13+)
        BEGIN
            ALTER TABLE users 
            ALTER COLUMN id SET DEFAULT gen_random_uuid();
            RAISE NOTICE '✅ DEFAULT gen_random_uuid() agregado a users.id';
        EXCEPTION WHEN OTHERS THEN
            -- Si gen_random_uuid() no está disponible, usar uuid_generate_v4() de uuid-ossp
            BEGIN
                -- Asegurar que la extensión uuid-ossp esté habilitada
                CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
                ALTER TABLE users 
                ALTER COLUMN id SET DEFAULT uuid_generate_v4();
                RAISE NOTICE '✅ DEFAULT uuid_generate_v4() agregado a users.id';
            EXCEPTION WHEN OTHERS THEN
                RAISE NOTICE '⚠️ No se pudo agregar DEFAULT a users.id. Error: %', SQLERRM;
            END;
        END;
    ELSE
        RAISE NOTICE 'ℹ️ La columna users.id ya tiene un DEFAULT configurado';
    END IF;
END $$;

-- Verificar el resultado
SELECT 
    column_name,
    column_default,
    is_nullable,
    data_type
FROM information_schema.columns
WHERE table_schema = 'public' 
  AND table_name = 'users' 
  AND column_name = 'id';
