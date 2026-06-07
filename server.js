const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('.'));

let db; // será preenchido na inicialização com o wrapper sql.js

function nowIso() {
    return new Date().toISOString();
}

function randomId(bytes = 12) {
    return crypto.randomBytes(bytes).toString('hex');
}

function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
}

async function ensureColumn(table, name, type, def) {
    const cols = await db.all(`PRAGMA table_info(${table})`);
    const colSet = new Set(cols.map(c => c.name));
    if (!colSet.has(name)) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type} DEFAULT ${def}`);
    }
}

const tableColumnsCache = new Map();
async function getTableColumns(table) {
    if (tableColumnsCache.has(table)) return tableColumnsCache.get(table);
    const cols = await db.all(`PRAGMA table_info(${table})`);
    const set = new Set(cols.map(c => c.name));
    tableColumnsCache.set(table, set);
    return set;
}

async function authMiddleware(req, res, next) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    if (!token) return res.status(401).json({ error: 'Não autenticado' });
    try {
        const row = await db.get(
            `SELECT u.id as userId, u.username, u.role, u.active
             FROM user_tokens t
             JOIN users u ON u.id = t.userId
             WHERE t.token = ?`,
            token
        );
        if (!row || !row.active) return res.status(401).json({ error: 'Sessão inválida' });
        await db.run(`UPDATE user_tokens SET lastSeen = ? WHERE token = ?`, nowIso(), token);
        req.user = { id: row.userId, username: row.username, role: row.role };
        return next();
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'Erro de autenticação' });
    }
}

function requireRole(role) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
        if (req.user.role !== role) return res.status(403).json({ error: 'Sem permissão' });
        return next();
    };
}

// ---- INICIALIZAÇÃO DO BANCO (sql.js - JavaScript puro, sem binários nativos) ----
(async () => {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs({
        locateFile: file => path.join(__dirname, 'node_modules/sql.js/dist', file)
    });

    // Caminho do banco
    const ORIG_DB = path.join(__dirname, 'database.sqlite');
    const TMP_DB  = '/tmp/database.sqlite';
    const dbFilePath = process.env.VERCEL ? TMP_DB : ORIG_DB;

    // No Vercel (cold start): copia o banco do bundle para /tmp
    if (process.env.VERCEL && !fs.existsSync(TMP_DB) && fs.existsSync(ORIG_DB)) {
        fs.copyFileSync(ORIG_DB, TMP_DB);
    }

    // Carrega o banco em memória
    let sqljsDb;
    if (fs.existsSync(dbFilePath)) {
        const buffer = fs.readFileSync(dbFilePath);
        sqljsDb = new SQL.Database(buffer);
    } else {
        sqljsDb = new SQL.Database();
    }

    // Persiste a memória de volta ao arquivo após cada escrita
    function save() {
        const data = sqljsDb.export();
        fs.writeFileSync(dbFilePath, Buffer.from(data));
    }

    // Wrapper que imita a API do pacote `sqlite` (get / all / run / exec)
    // params usa .flat() para aceitar tanto args espalhados quanto array único
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

    // Cria tabelas
    sqljsDb.exec(`
        CREATE TABLE IF NOT EXISTS vehicles (
            id TEXT PRIMARY KEY,
            placa TEXT,
            modelo TEXT,
            tipo TEXT,
            combustivel TEXT,
            kmAtual INTEGER,
            kmUltimaManutencao INTEGER DEFAULT 0,
            kmProximaManutencao INTEGER DEFAULT 10000,
            kmTrocaOleo INTEGER DEFAULT 0,
            kmProximoOleo INTEGER DEFAULT 10000,
            kmTrocaPneus INTEGER DEFAULT 0,
            kmProximoPneus INTEGER DEFAULT 40000,
            ano INTEGER,
            cor TEXT,
            ativo BOOLEAN
        );
        CREATE TABLE IF NOT EXISTS maintenance_logs (
            id TEXT PRIMARY KEY,
            veiculoId TEXT,
            data TEXT,
            descricao TEXT,
            valor REAL,
            kmNoMomento INTEGER
        );
        CREATE TABLE IF NOT EXISTS drivers (
            id TEXT PRIMARY KEY,
            nome TEXT,
            cnh TEXT,
            categoria TEXT,
            telefone TEXT,
            valorDiaria REAL,
            valorDomingo REAL DEFAULT 0,
            ativo BOOLEAN
        );
        CREATE TABLE IF NOT EXISTS routes (
            id TEXT PRIMARY KEY,
            data TEXT,
            motoristaId TEXT,
            veiculoId TEXT,
            origem TEXT,
            destino TEXT,
            km REAL,
            valorFrete REAL,
            tipoCarga TEXT,
            observacoes TEXT
        );
        CREATE TABLE IF NOT EXISTS fuel (
            id TEXT PRIMARY KEY,
            data TEXT,
            veiculoId TEXT,
            tipoCombustivel TEXT,
            litros REAL,
            valorLitro REAL,
            valorTotal REAL,
            kmAbastecimento INTEGER,
            posto TEXT
        );
        CREATE TABLE IF NOT EXISTS payables (
            id TEXT PRIMARY KEY,
            descricao TEXT,
            valor REAL,
            vencimento TEXT,
            categoria TEXT,
            status TEXT
        );
        CREATE TABLE IF NOT EXISTS receivables (
            id TEXT PRIMARY KEY,
            descricao TEXT,
            valor REAL,
            vencimento TEXT,
            cliente TEXT,
            status TEXT
        );
        CREATE TABLE IF NOT EXISTS adiantamentos (
            id TEXT PRIMARY KEY,
            data TEXT,
            motoristaId TEXT,
            valor REAL,
            observacao TEXT
        );
        CREATE TABLE IF NOT EXISTS driver_adjustments (
            id TEXT PRIMARY KEY,
            data TEXT,
            motoristaId TEXT,
            tipo TEXT,
            valor REAL,
            observacao TEXT
        );
        CREATE TABLE IF NOT EXISTS driver_payments (
            id TEXT PRIMARY KEY,
            motoristaId TEXT,
            mes INTEGER,
            ano INTEGER,
            diasTrabalhados INTEGER,
            diasDomingo INTEGER DEFAULT 0,
            valorDiaria REAL,
            valorDomingo REAL DEFAULT 0,
            valorBrutoDiarias REAL DEFAULT 0,
            adiantamentos REAL,
            valorFinal REAL,
            pago BOOLEAN
        );
        CREATE TABLE IF NOT EXISTS invoices (
            id TEXT PRIMARY KEY,
            data TEXT,
            numero TEXT,
            descricao TEXT,
            tipo TEXT,
            valor REAL,
            fornecedor TEXT,
            foto TEXT
        );
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE,
            passwordHash TEXT,
            salt TEXT,
            role TEXT,
            active INTEGER,
            createdAt TEXT
        );
        CREATE TABLE IF NOT EXISTS user_tokens (
            token TEXT PRIMARY KEY,
            userId TEXT,
            createdAt TEXT,
            lastSeen TEXT
        );
        CREATE TABLE IF NOT EXISTS audit_logs (
            id TEXT PRIMARY KEY,
            ts TEXT,
            userId TEXT,
            action TEXT,
            entity TEXT,
            entityId TEXT,
            payload TEXT
        );
    `);
    save();

    await ensureColumn('vehicles', 'kmUltimaManutencao', 'INTEGER', 0);
    await ensureColumn('vehicles', 'kmProximaManutencao', 'INTEGER', 10000);
    await ensureColumn('vehicles', 'kmTrocaOleo', 'INTEGER', 0);
    await ensureColumn('vehicles', 'kmProximoOleo', 'INTEGER', 10000);
    await ensureColumn('vehicles', 'kmTrocaPneus', 'INTEGER', 0);
    await ensureColumn('vehicles', 'kmProximoPneus', 'INTEGER', 40000);

    await ensureColumn('drivers', 'valorDomingo', 'REAL', 0);

    await ensureColumn('driver_payments', 'periodoTipo', 'TEXT', `'mensal'`);
    await ensureColumn('driver_payments', 'periodoInicio', 'TEXT', `''`);
    await ensureColumn('driver_payments', 'periodoFim', 'TEXT', `''`);
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

// ---- ROTAS ----

app.get('/api/health', async (req, res) => {
    try {
        await db.get('SELECT 1 as ok');
        res.json({ ok: true, time: nowIso() });
    } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false });
    }
});

app.get('/api/auth/status', async (req, res) => {
    try {
        const row = await db.get(`SELECT COUNT(1) as c FROM users`);
        res.json({ hasUsers: (row?.c || 0) > 0 });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro' });
    }
});

app.post('/api/auth/bootstrap', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: 'Dados inválidos' });
        const row = await db.get(`SELECT COUNT(1) as c FROM users`);
        if ((row?.c || 0) > 0) return res.status(409).json({ error: 'Já inicializado' });
        const salt = randomId(8);
        const passwordHash = hashPassword(password, salt);
        const userId = randomId();
        await db.run(
            `INSERT INTO users (id, username, passwordHash, salt, role, active, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            userId, username, passwordHash, salt, 'admin', 1, nowIso()
        );
        res.json({ ok: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: 'Dados inválidos' });
        const user = await db.get(`SELECT * FROM users WHERE username = ?`, username);
        if (!user || !user.active) return res.status(401).json({ error: 'Credenciais inválidas' });
        const expected = hashPassword(password, user.salt);
        if (expected !== user.passwordHash) return res.status(401).json({ error: 'Credenciais inválidas' });
        const token = randomId(24);
        await db.run(
            `INSERT INTO user_tokens (token, userId, createdAt, lastSeen) VALUES (?, ?, ?, ?)`,
            token, user.id, nowIso(), nowIso()
        );
        res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro' });
    }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
    res.json({ user: req.user });
});

app.post('/api/auth/logout', authMiddleware, async (req, res) => {
    try {
        const auth = req.headers.authorization || '';
        const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
        if (token) await db.run(`DELETE FROM user_tokens WHERE token = ?`, token);
        res.json({ ok: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro' });
    }
});

app.get('/api/admin/users', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const rows = await db.all(`SELECT id, username, role, active, createdAt FROM users ORDER BY createdAt DESC`);
        res.json(rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro' });
    }
});

// Generic API endpoints
const entities = ['vehicles', 'drivers', 'routes', 'fuel', 'payables', 'receivables', 'adiantamentos', 'driver_adjustments', 'driver_payments', 'invoices', 'maintenance_logs'];

entities.forEach(entity => {
    app.get(`/api/${entity}`, async (req, res) => {
        try {
            const rows = await db.all(`SELECT * FROM ${entity}`);
            res.json(rows);
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: 'Erro ao consultar' });
        }
    });

    app.get(`/api/${entity}/:id`, async (req, res) => {
        try {
            const row = await db.get(`SELECT * FROM ${entity} WHERE id = ?`, req.params.id);
            res.json(row);
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: 'Erro ao consultar' });
        }
    });

    app.post(`/api/${entity}`, async (req, res) => {
        try {
            const item = req.body;
            if (!item.id) item.id = Math.random().toString(36).substr(2, 9);

            const allowed = await getTableColumns(entity);
            const keys = Object.keys(item).filter(k => allowed.has(k));
            const values = keys.map(k => item[k]);
            const placeholders = keys.map(() => '?').join(',');

            await db.run(
                `INSERT OR REPLACE INTO ${entity} (${keys.join(',')}) VALUES (${placeholders})`,
                values
            );
            res.json(item);
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: 'Erro ao salvar' });
        }
    });

    app.delete(`/api/${entity}/:id`, async (req, res) => {
        try {
            await db.run(`DELETE FROM ${entity} WHERE id = ?`, req.params.id);
            res.send({ success: true });
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: 'Erro ao excluir' });
        }
    });
});

// Seed endpoint
app.post('/api/seed', async (req, res) => {
    const data = req.body;
    for (const entity of Object.keys(data)) {
        if (entities.includes(entity)) {
            await db.run(`DELETE FROM ${entity}`);
            for (const item of data[entity]) {
                const allowed = await getTableColumns(entity);
                const keys = Object.keys(item).filter(k => allowed.has(k));
                const values = keys.map(k => item[k]);
                const placeholders = keys.map(() => '?').join(',');
                await db.run(`INSERT INTO ${entity} (${keys.join(',')}) VALUES (${placeholders})`, values);
            }
        }
    }
    res.send({ success: true });
});

// Backup endpoint
app.get('/api/backup', async (req, res) => {
    try {
        const dbPath = process.env.VERCEL ? '/tmp/database.sqlite' : path.join(__dirname, 'database.sqlite');
        res.download(dbPath, `backup_${new Date().toISOString().slice(0, 10)}.sqlite`);
    } catch (e) {
        res.status(500).json({ error: 'Erro ao gerar backup' });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       