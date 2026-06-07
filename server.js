const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('.'));

let db;

function nowIso() { return new Date().toISOString(); }
function randomId(bytes = 12) { return crypto.randomBytes(bytes).toString('hex'); }

async function ensureColumn(table, name, type, def) {
    const cols = await db.all(`PRAGMA table_info(${table})`);
    const colSet = new Set(cols.map(c => c.name));
    if (!colSet.has(name)) await db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type} DEFAULT ${def}`);
}

const tableColumnsCache = new Map();
async function getTableColumns(table) {
    if (tableColumnsCache.has(table)) return tableColumnsCache.get(table);
    const cols = await db.all(`PRAGMA table_info(${table})`);
    const set = new Set(cols.map(c => c.name));
    tableColumnsCache.set(table, set);
    return set;
}

(async () => {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs({
        locateFile: file => path.join(__dirname, 'node_modules/sql.js/dist', file)
    });

    const ORIG_DB = path.join(__dirname, 'database.sqlite');
    const TMP_DB  = '/tmp/database.sqlite';
    const dbFilePath = process.env.VERCEL ? TMP_DB : ORIG_DB;

    if (process.env.VERCEL && !fs.existsSync(TMP_DB) && fs.existsSync(ORIG_DB)) {
        fs.copyFileSync(ORIG_DB, TMP_DB);
    }

    let sqljsDb;
    if (fs.existsSync(dbFilePath)) {
        const buffer = fs.readFileSync(dbFilePath);
        sqljsDb = new SQL.Database(buffer);
    } else {
        sqljsDb = new SQL.Database();
    }

    function save() {
        const data = sqljsDb.export();
        fs.writeFileSync(dbFilePath, Buffer.from(data));
    }

    db = {
        async get(sql, ...params) {
            const stmt = sqljsDb.prepare(sql);
            stmt.bind(params.flat());
            const row = stmt.step() ? stmt.getAsObject() : undefined;
            stmt.free();
            return row;
        },
        async all(sql, ...params) {
            const stmt = sqljsDb.prepare(sql);
            stmt.bind(params.flat());
            const rows = [];
            while (stmt.step()) rows.push(stmt.getAsObject());
            stmt.free();
            return rows;
        },
        async run(sql, ...params) {
            sqljsDb.run(sql, params.flat());
            save();
        },
        async exec(sql) {
            sqljsDb.exec(sql);
            save();
        }
    };

    sqljsDb.exec(`
        CREATE TABLE IF NOT EXISTS vehicles (id TEXT PRIMARY KEY, placa TEXT, modelo TEXT, tipo TEXT, combustivel TEXT, kmAtual INTEGER, kmUltimaManutencao INTEGER DEFAULT 0, kmProximaManutencao INTEGER DEFAULT 10000, kmTrocaOleo INTEGER DEFAULT 0, kmProximoOleo INTEGER DEFAULT 10000, kmTrocaPneus INTEGER DEFAULT 0, kmProximoPneus INTEGER DEFAULT 40000, ano INTEGER, cor TEXT, ativo BOOLEAN);
        CREATE TABLE IF NOT EXISTS maintenance_logs (id TEXT PRIMARY KEY, veiculoId TEXT, data TEXT, descricao TEXT, valor REAL, kmNoMomento INTEGER);
        CREATE TABLE IF NOT EXISTS drivers (id TEXT PRIMARY KEY, nome TEXT, cnh TEXT, categoria TEXT, telefone TEXT, valorDiaria REAL, valorDomingo REAL DEFAULT 0, ativo BOOLEAN);
        CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, data TEXT, motoristaId TEXT, veiculoId TEXT, origem TEXT, destino TEXT, km REAL, valorFrete REAL, tipoCarga TEXT, observacoes TEXT);
        CREATE TABLE IF NOT EXISTS fuel (id TEXT PRIMARY KEY, data TEXT, veiculoId TEXT, tipoCombustivel TEXT, litros REAL, valorLitro REAL, valorTotal REAL, kmAbastecimento INTEGER, posto TEXT);
        CREATE TABLE IF NOT EXISTS payables (id TEXT PRIMARY KEY, descricao TEXT, valor REAL, vencimento TEXT, categoria TEXT, status TEXT);
        CREATE TABLE IF NOT EXISTS receivables (id TEXT PRIMARY KEY, descricao TEXT, valor REAL, vencimento TEXT, cliente TEXT, status TEXT);
        CREATE TABLE IF NOT EXISTS adiantamentos (id TEXT PRIMARY KEY, data TEXT, motoristaId TEXT, valor REAL, observacao TEXT);
        CREATE TABLE IF NOT EXISTS driver_adjustments (id TEXT PRIMARY KEY, data TEXT, motoristaId TEXT, tipo TEXT, valor REAL, observacao TEXT);
        CREATE TABLE IF NOT EXISTS driver_payments (id TEXT PRIMARY KEY, motoristaId TEXT, mes INTEGER, ano INTEGER, diasTrabalhados INTEGER, diasDomingo INTEGER DEFAULT 0, valorDiaria REAL, valorDomingo REAL DEFAULT 0, valorBrutoDiarias REAL DEFAULT 0, adiantamentos REAL, valorFinal REAL, pago BOOLEAN);
        CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, data TEXT, numero TEXT, descricao TEXT, tipo TEXT, valor REAL, fornecedor TEXT, foto TEXT);
        CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, passwordHash TEXT, salt TEXT, role TEXT, active INTEGER, createdAt TEXT);
        CREATE TABLE IF NOT EXISTS user_tokens (token TEXT PRIMARY KEY, userId TEXT, createdAt TEXT, lastSeen TEXT);
        CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, ts TEXT, userId TEXT, action TEXT, entity TEXT, entityId TEXT, payload TEXT);
    `);
    save();

    await ensureColumn('vehicles', 'kmUltimaManutencao', 'INTEGER', 0);
    await ensureColumn('vehicles', 'kmProximaManutencao', 'INTEGER', 10000);
    await ensureColumn('vehicles', 'kmTrocaOleo', 'INTEGER', 0);
    await ensureColumn('vehicles', 'kmProximoOleo', 'INTEGER', 10000);
    await ensureColumn('vehicles', 'kmTrocaPneus', 'INTEGER', 0);
    await ensureColumn('vehicles', 'kmProximoPneus', 'INTEGER', 40000);
    await ensureColumn('drivers', 'valorDomingo', 'REAL', 0);
    await ensureColumn('driver_payments', 'periodoTipo', 'TEXT', "'mensal'");
    await ensureColumn('driver_payments', 'periodoInicio', 'TEXT', "''");
    await ensureColumn('driver_payments', 'periodoFim', 'TEXT', "''");
    await ensureColumn('driver_payments', 'pnr', 'REAL', 0);
    await ensureColumn('driver_payments', 'descontos', 'REAL', 0);
    await ensureColumn('driver_payments', 'extras', 'REAL', 0);
    await ensureColumn('driver_payments', 'rotasCount', 'INTEGER', 0);
    await ensureColumn('driver_payments', 'kmTotal', 'REAL', 0);
    await ensureColumn('driver_payments', 'freteTotal', 'REAL', 0);
    await ensureColumn('driver_payments', 'diasDomingo', 'INTEGER', 0);
    await ensureColumn('driver_payments', 'valorDomingo', 'REAL', 0);
    await ensureColumn('driver_payments', 'valorBrutoDiarias', 'REAL', 0);

    console.log('Database initialized (sql.js).');
})();

app.get('/api/health', async (req, res) => {
    try { await db.get('SELECT 1 as ok'); res.json({ ok: true, time: nowIso() }); }
    catch (e) { res.status(500).json({ ok: false }); }
});

const entities = ['vehicles','drivers','routes','fuel','payables','receivables','adiantamentos','driver_adjustments','driver_payments','invoices','maintenance_logs'];

entities.forEach(entity => {
    app.get(`/api/${entity}`, async (req, res) => {
        try { res.json(await db.all(`SELECT * FROM ${entity}`)); }
        catch (e) { res.status(500).json({ error: 'Erro ao consultar' }); }
    });

    app.get(`/api/${entity}/:id`, async (req, res) => {
        try { res.json(await db.get(`SELECT * FROM ${entity} WHERE id = ?`, req.params.id)); }
        catch (e) { res.status(500).json({ error: 'Erro ao consultar' }); }
    });

    app.post(`/api/${entity}`, async (req, res) => {
        try {
            const item = req.body;
            if (!item.id) item.id = Math.random().toString(36).substr(2, 9);
            const allowed = await getTableColumns(entity);
            const keys = Object.keys(item).filter(k => allowed.has(k));
            const values = keys.map(k => item[k]);
            const placeholders = keys.map(() => '?').join(',');
            await db.run(`INSERT OR REPLACE INTO ${entity} (${keys.join(',')}) VALUES (${placeholders})`, values);
            res.json(item);
        } catch (e) { res.status(500).json({ error: 'Erro ao salvar' }); }
    });

    app.delete(`/api/${entity}/:id`, async (req, res) => {
        try { await db.run(`DELETE FROM ${entity} WHERE id = ?`, req.params.id); res.json({ success: true }); }
        catch (e) { res.status(500).json({ error: 'Erro ao excluir' }); }
    });
});

app.post('/api/seed', async (req, res) => {
    try {
        const data = req.body;
        for (const entity of Object.keys(data)) {
            if (!entities.includes(entity)) continue;
            await db.run(`DELETE FROM ${entity}`);
            for (const item of data[entity]) {
                const allowed = await getTableColumns(entity);
                const keys = Object.keys(item).filter(k => allowed.has(k));
                const values = keys.map(k => item[k]);
                const placeholders = keys.map(() => '?').join(',');
                await db.run(`INSERT INTO ${entity} (${keys.join(',')}) VALUES (${placeholders})`, values);
            }
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Erro no seed' }); }
});

app.get('/api/backup', async (req, res) => {
    try {
        const dbPath = process.env.VERCEL ? '/tmp/database.sqlite' : path.join(__dirname, 'database.sqlite');
        res.download(dbPath, `backup_${new Date().toISOString().slice(0,10)}.sqlite`);
    } catch (e) { res.status(500).json({ error: 'Erro ao gerar backup' }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
