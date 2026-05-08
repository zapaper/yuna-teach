-- Extend the Language enum with MALAY and TAMIL so spelling-list
-- scans can auto-detect those alongside Chinese / English / Japanese.
ALTER TYPE "Language" ADD VALUE IF NOT EXISTS 'MALAY';
ALTER TYPE "Language" ADD VALUE IF NOT EXISTS 'TAMIL';
