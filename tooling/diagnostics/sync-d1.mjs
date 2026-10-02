import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function prepareSql(filePath, io = fs) {
    let sql = io.readFileSync(filePath, 'utf8');
    // Drop table before create table
    sql = sql.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([`"a-zA-Z0-9_]+)/g, (match, tableName) => {
        return `DROP TABLE IF EXISTS ${tableName};\n${match}`;
    });
    // Drop trigger before create trigger
    sql = sql.replace(/CREATE TRIGGER\s+(?:IF NOT EXISTS\s+)?([`"a-zA-Z0-9_]+)/g, (match, triggerName) => {
        return `DROP TRIGGER IF EXISTS ${triggerName};\n${match}`;
    });
    return sql;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function syncLocalD1({ confirmReplace = false, io = fs, execute = execFileSync,
    logger = console, sourceName = process.env.FLARETUNE_SOURCE_D1_NAME || 'flaretune-source' } = {}) {
    if (!confirmReplace) {
        logger.error('Local data replacement requires --replace-local-data and a local backup.');
        return 1;
    }
    const backupsDir = path.join(rootDir, 'output', 'backups');
    const databases = [
        {
            name: sourceName,
            binding: 'DB',
            remoteFile: path.join(backupsDir, 'source-d1-export.sql'),
            preparedFile: path.join(backupsDir, 'source-d1-prepared.sql'),
        },
    ];

    logger.log('1. Preparing SQL files with DROP IF EXISTS...');
    for (const db of databases) {
        const preparedSql = prepareSql(db.remoteFile, io);
        io.writeFileSync(db.preparedFile, preparedSql, 'utf8');
        logger.log(`  - Prepared ${db.name}`);
    }

    logger.log('2. Executing prepared SQL on local D1 databases...');
    let failed = false;
    for (const db of databases) {
        logger.log(`  - Syncing ${db.binding} (${db.name})...`);
        try {
            execute(process.execPath, [path.join(rootDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
                'd1', 'execute', db.binding, '--local', '--config', 'wrangler.local.toml',
                '--persist-to', path.join(rootDir, 'worker', '.wrangler', 'state'), '--file', db.preparedFile],
            { cwd: path.join(rootDir, 'server'), stdio: 'inherit' });
            logger.log(`  ✓ Synced ${db.binding}`);
        } catch (err) {
            logger.error(`  ✗ Failed to sync ${db.binding}:`, err.message);
            failed = true;
        }
    }

    if (!failed) logger.log('3. Sync complete!');
    return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { process.exitCode = syncLocalD1({ confirmReplace: process.argv.includes('--replace-local-data') }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
