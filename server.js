const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const port = process.env.PORT || 10000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

async function initDb() {
    try {
        await pool.query(`
            CREATE SCHEMA IF NOT EXISTS binaryusers;

            CREATE TABLE IF NOT EXISTS binaryusers.users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                phone_number VARCHAR(20) UNIQUE,
                password_hash TEXT NOT NULL,
                demo_balance NUMERIC(12, 2) DEFAULT 10000.00,
                real_balance NUMERIC(12, 2) DEFAULT 0.00,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS binaryusers.trades (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES binaryusers.users(id) ON DELETE CASCADE,
                account_type VARCHAR(10) NOT NULL,
                stake NUMERIC(12, 2) NOT NULL,
                trade_type VARCHAR(20) NOT NULL,
                status VARCHAR(20) DEFAULT 'OPEN',
                payout NUMERIC(12, 2) DEFAULT 0.00,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS binaryusers.transactions (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES binaryusers.users(id) ON DELETE CASCADE,
                type VARCHAR(20) NOT NULL,
                amount NUMERIC(12, 2) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                status VARCHAR(20) DEFAULT 'PENDING',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("Database schema initialized successfully!");
    } catch (err) {
        console.error("Error initializing database:", err);
    }
}
initDb();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Explicit Registration Endpoint
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    try {
        const userCheck = await pool.query('SELECT id FROM binaryusers.users WHERE email = $1', [email]);
        if (userCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: "Email is already registered. Please sign in." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = await pool.query(
            'INSERT INTO binaryusers.users (email, password_hash) VALUES ($1, $2) RETURNING id, email, demo_balance, real_balance',
            [email, hashedPassword]
        );
        const user = newUser.rows[0];

        return res.json({ 
            success: true, 
            message: "Account created successfully! You are now logged in.", 
            userId: user.id,
            email: user.email,
            demoBalance: user.demo_balance, 
            realBalance: user.real_balance 
        });
    } catch (err) {
        console.error("Registration Error:", err);
        res.status(500).json({ success: false, message: "Database error during registration." });
    }
});

// Explicit Login Endpoint
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    try {
        const userCheck = await pool.query('SELECT * FROM binaryusers.users WHERE email = $1', [email]);
        
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: "No account found with this email. Please register first." });
        }

        const user = userCheck.rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ success: false, message: "Incorrect password." });
        }

        return res.json({ 
            success: true, 
            message: "Login successful!", 
            userId: user.id,
            email: user.email,
            demoBalance: user.demo_balance, 
            realBalance: user.real_balance 
        });
    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ success: false, message: "Database error during login." });
    }
});

// Record Trade Entry
app.post('/api/trade/place', async (req, res) => {
    const { userId, accountType, stake, tradeType } = req.body;
    if (!userId || !stake || !tradeType || !accountType) {
        return res.status(400).json({ success: false, message: "Invalid trade payload." });
    }

    try {
        const balanceField = accountType === 'demo' ? 'demo_balance' : 'real_balance';
        const userRes = await pool.query(`SELECT ${balanceField} FROM binaryusers.users WHERE id = $1`, [userId]);
        
        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        const currentBal = parseFloat(userRes.rows[0][balanceField]);
        if (stake > currentBal) {
            return res.status(400).json({ success: false, message: "Insufficient balance." });
        }

        const updatedUser = await pool.query(
            `UPDATE binaryusers.users SET ${balanceField} = ${balanceField} - $1 WHERE id = $2 RETURNING demo_balance, real_balance`,
            [stake, userId]
        );

        const tradeRes = await pool.query(
            `INSERT INTO binaryusers.trades (user_id, account_type, stake, trade_type, status) 
             VALUES ($1, $2, $3, $4, 'OPEN') RETURNING id`,
            [userId, accountType, stake, tradeType]
        );

        res.json({
            success: true,
            tradeId: tradeRes.rows[0].id,
            demoBalance: updatedUser.rows[0].demo_balance,
            realBalance: updatedUser.rows[0].real_balance
        });
    } catch (err) {
        console.error("Trade Place Error:", err);
        res.status(500).json({ success: false, message: "Failed to place trade." });
    }
});

// Settle Completed Trade
app.post('/api/trade/settle', async (req, res) => {
    const { tradeId, userId, accountType, result, payout } = req.body;

    try {
        await pool.query(
            `UPDATE binaryusers.trades SET status = $1, payout = $2 WHERE id = $3 AND user_id = $4`,
            [result, payout || 0, tradeId, userId]
        );

        let updatedUser;
        if (payout > 0) {
            const balanceField = accountType === 'demo' ? 'demo_balance' : 'real_balance';
            updatedUser = await pool.query(
                `UPDATE binaryusers.users SET ${balanceField} = ${balanceField} + $1 WHERE id = $2 RETURNING demo_balance, real_balance`,
                [payout, userId]
            );
        } else {
            const userRes = await pool.query(`SELECT demo_balance, real_balance FROM binaryusers.users WHERE id = $1`, [userId]);
            updatedUser = userRes;
        }

        res.json({
            success: true,
            demoBalance: updatedUser.rows[0].demo_balance,
            realBalance: updatedUser.rows[0].real_balance
        });
    } catch (err) {
        console.error("Trade Settle Error:", err);
        res.status(500).json({ success: false, message: "Failed to settle trade." });
    }
});

// M-Pesa Deposit Endpoint
app.post('/api/deposit', async (req, res) => {
    const { userId, amount, phone } = req.body;
    
    if (!userId) {
        return res.status(401).json({ success: false, message: "You must be logged in to deposit." });
    }

    const phoneRegex = /^(07|01)[0-9]{8}$/;
    if (!phone || !phoneRegex.test(phone)) {
        return res.status(400).json({ success: false, message: "Invalid Kenyan phone number format. Must be 10 digits starting with 07 or 01." });
    }

    try {
        await pool.query(
            `INSERT INTO binaryusers.transactions (user_id, type, amount, phone, status) VALUES ($1, 'DEPOSIT', $2, $3, 'COMPLETED')`,
            [userId, amount, phone]
        );

        const convertedUSD = (parseFloat(amount) / 130).toFixed(2);
        const updatedUser = await pool.query(
            `UPDATE binaryusers.users SET real_balance = real_balance + $1, phone_number = COALESCE(phone_number, $2) WHERE id = $3 RETURNING real_balance, demo_balance`,
            [convertedUSD, phone, userId]
        );

        res.status(200).json({
            success: true,
            message: `STK Push processed! Credited $${convertedUSD} to Real Account.`,
            realBalance: updatedUser.rows[0].real_balance,
            demoBalance: updatedUser.rows[0].demo_balance
        });
    } catch (err) {
        console.error("Deposit Error:", err);
        res.status(500).json({ success: false, message: "Deposit transaction failed." });
    }
});

// Withdrawal Request Endpoint
app.post('/api/withdraw', async (req, res) => {
    const { userId, amount, phone } = req.body;
    
    if (!userId) {
        return res.status(401).json({ success: false, message: "You must be logged in to withdraw." });
    }

    const phoneRegex = /^(07|01)[0-9]{8}$/;
    if (!phone || !phoneRegex.test(phone)) {
        return res.status(400).json({ success: false, message: "Invalid Kenyan phone number format. Must be 10 digits starting with 07 or 01." });
    }

    try {
        const userRes = await pool.query(`SELECT real_balance FROM binaryusers.users WHERE id = $1`, [userId]);
        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        const currentRealBalance = parseFloat(userRes.rows[0].real_balance);
        const withdrawAmount = parseFloat(amount);

        if (withdrawAmount <= 0 || currentRealBalance < withdrawAmount) {
            return res.status(400).json({ success: false, message: `Insufficient real account balance ($${currentRealBalance.toFixed(2)}) for this withdrawal.` });
        }

        const updatedUser = await pool.query(
            `UPDATE binaryusers.users SET real_balance = real_balance - $1 WHERE id = $2 RETURNING real_balance, demo_balance`,
            [withdrawAmount, userId]
        );

        await pool.query(
            `INSERT INTO binaryusers.transactions (user_id, type, amount, phone, status) VALUES ($1, 'WITHDRAWAL', $2, $3, 'COMPLETED')`,
            [userId, withdrawAmount, phone]
        );

        res.status(200).json({
            success: true,
            message: `Withdrawal request of $${withdrawAmount.toFixed(2)} processed to ${phone}.`,
            realBalance: updatedUser.rows[0].real_balance,
            demoBalance: updatedUser.rows[0].demo_balance
        });
    } catch (err) {
        console.error("Withdraw Error:", err);
        res.status(500).json({ success: false, message: "Withdrawal transaction failed." });
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});