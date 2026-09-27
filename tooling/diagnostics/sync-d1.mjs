import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function prepareSql(filePath) {
    let sql = fs.readFileSync(filePath, 'utf8');
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
const backupsDir = path.join(rootDir, 'output', 'backups');

const databases = [
    {
        name: process.env.FLARETUNE_SOURCE_D1_NAME || 'flaretune-source',
        binding: 'DB',
        remoteFile: path.join(backupsDir, 'source-d1-export.sql'),
        preparedFile: path.join(backupsDir, 'source-d1-prepared.sql'),
    },
];

console.log('1. Preparing SQL files with DROP IF EXISTS...');
for (const db of databases) {
    const preparedSql = prepareSql(db.remoteFile);
    fs.writeFileSync(db.preparedFile, preparedSql, 'utf8');
    console.log(`  - Prepared ${db.name}`);
}

console.log('2. Executing prepared SQL on local D1 databases...');
for (const db of databases) {
    console.log(`  - Syncing ${db.binding} (${db.name})...`);
    try {
        execFileSync(process.execPath, [path.join(rootDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
            'd1', 'execute', db.binding, '--local', '--config', 'wrangler.local.toml', '--file', db.preparedFile],
        { cwd: path.join(rootDir, 'server'), stdio: 'inherit' });
        console.log(`  ✓ Synced ${db.binding}`);
    } catch (err) {
        console.error(`  ✗ Failed to sync ${db.binding}:`, err.message);
    }
}

console.log('3. Sync complete!');
