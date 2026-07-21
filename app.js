process.env.TZ = "Africa/Lagos";
const express = require("express");

const cors = require("cors");
const bodyParser = require("body-parser");
const cron = require("node-cron");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const db = require("./DB");

const JWT_SECRET = process.env.JWT_SECRET || "smart_earn_secret_key_2026";

function verifyToken(req, res, next) {
    const authHeader = req.headers["authorization"];

    if (!authHeader) {
        return res.status(403).send("No token provided");
    }

    const token = authHeader.split(" ")[1];

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(401).send("Invalid token");
        }

        req.user = decoded;
        next();
    });
}

const app = express();

app.use(cors());
app.use(express.json());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

// STATIC FILES
app.use(express.static(path.join(__dirname, "public")));
app.use("/ezeaguuy", express.static(path.join(__dirname, "ezeaguuy")));

// BLOCK ADMIN FILE ACCESS (optional)
// app.use("/admin", (req, res) => {
//     return res.status(403).send("Access denied");
// });

app.get("/ezeaguuy/login.html", (req, res) => {
    res.sendFile(path.join(__dirname, "ezeaguuy", "login.html"));
});

app.get("/ezeaguuy/users", (req, res) => {

    db.query(
        "SELECT id, phone, balance, status FROM users ORDER BY id DESC",
        (err, users) => {

            if (err) {
                return res.status(500).json({ error: "DB error" });
            }

            return res.json(users || []);
        }
    );
});
// ================= DATABASE =================



// ADMIN LOGIN ROUTE

// ADMIN DASHBOARD ROUTE
app.get("/ezeaguuy/dashboard", (req, res) => {

    return res.sendFile(
        path.join(__dirname, "ezeaguuy", "dashboard.html")
    );
});

// SUPPORT BOTH URL FORMATS
app.get("/ezeaguuy/dashboard.html", (req, res) => {

    return res.sendFile(
        path.join(__dirname, "ezeaguuy", "dashboard.html")
    );
});

// HOME ROUTE
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});


// =====================================================
// 🔥 UTILITY FUNCTIONS (REFERRAL SYSTEM)
// =====================================================

// ✅ UNIQUE REFERRAL CODE GENERATOR
function generateReferralCode() {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const numbers = "0123456789";

    let code = "REF-";

    for (let i = 0; i < 3; i++) {
        code += letters[Math.floor(Math.random() * letters.length)];
    }

    for (let i = 0; i < 5; i++) {
        code += numbers[Math.floor(Math.random() * numbers.length)];
    }

    return code;
}

// CREATE UPLOADS FOLDER
if (!fs.existsSync(path.join(__dirname, "uploads"))) {
    fs.mkdirSync(path.join(__dirname, "uploads"));
}

// MULTER CONFIG
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, "uploads"));
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + "-" + file.originalname);
    }
});

const upload = multer({ storage });

// SERVE UPLOADED FILES
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// TEST CONNECTION


// CHECK USER STATUS FOR LOCKING
function checkUserStatus(phone, cb) {
    db.query(
        "SELECT status FROM users WHERE phone=?",
        [phone],
        (err, result) => {
            if (err || !result || !result.length) {
                return cb(false);
            }
            cb(result[0].status === "active");
        }
    );
}

// ================= DAILY INVESTMENT SYSTEM =================
// runs every 12AM
cron.schedule("0 0 * * *", () => {

    console.log("🔥 DAILY INTEREST STARTED:", new Date().toString());

    // STEP 1: TRY GLOBAL LOCK (ONLY ONE SERVER CAN WIN)
    db.query(
        `INSERT INTO system_locks (lock_name, locked_at)
         VALUES ('daily_interest', NOW())
         ON DUPLICATE KEY UPDATE locked_at = locked_at`,
        (lockErr, lockRes) => {

            if (lockErr) {
                console.log("Lock error:", lockErr);
                return;
            }

            // ❌ IF LOCK ALREADY EXISTS → STOP EVERYTHING
            if (lockRes.affectedRows === 0) {
                console.log("⚠️ Job already running on another server. SKIPPED.");
                return;
            }

            // STEP 2: EXPIRE INVESTMENTS
            db.query(
    `UPDATE investments 
     SET status='expired'
     WHERE status='active'
     AND end_date <= NOW()`,
    (err, result) => {

        if (err) {
            console.log("❌ Expiry error:", err);
            return;
        }

        console.log("✅ Expired investments:", result.affectedRows);
    }
);

            // STEP 3: GET INVESTMENTS (PHONE BASED)
            db.query(
                `SELECT id, phone, amount, last_interest_time,end_date 
                 FROM investments 
                 WHERE status='active'
                 AND end_date >NOW()`,
                (err, results) => {

                    if (err) {
                        console.log("Interest fetch error:", err);
                        return;
                    }

                    results.forEach(row => {

                        const today = new Date();
                        today.setHours(0,0,0,0);

                        const last = row.last_interest_time
                            ? new Date(row.last_interest_time)
                            : null;

                        // ❌ SKIP IF ALREADY TODAY
                        if (last && last >= today) return;

                        const interest = Number(row.amount) * 0.10;

                        // STEP 4: ATOMIC UPDATE (SECOND SAFETY LAYER)
                        db.query(
                            `UPDATE investments 
                             SET last_interest_time = NOW() 
                             WHERE id=? 
                             AND status='active'
                             AND end_date > NOW()
                             AND (last_interest_time IS NULL OR DATE(last_interest_time) < CURDATE())`,
                            [row.id],
                            (err2, result) => {

                                if (result.affectedRows === 0) return;

                                // CREDIT USER
                                db.query(
                                    `UPDATE users 
                                     SET total_returns = total_returns + ? 
                                     WHERE phone=?`,
                                    [interest, row.phone]
                                );

                                // HISTORY
                                db.query(
                                    `INSERT INTO interest_history 
                                     (phone, amount, interest)
                                     VALUES (?, ?, ?)`,
                                    [row.phone, row.amount, interest]
                                );
                            }
                        );
                    });

                    // STEP 5: RELEASE LOCK (OPTIONAL SAFETY RESET)
                    setTimeout(() => {
                        db.query(`
                            DELETE FROM system_locks WHERE lock_name='daily_interest'
                        `);
                    }, 1000 * 60); // 1 min later
                }
            );
        }
    );

}, {
    timezone: "Africa/Lagos"
});
// ================= SIGNUP =================
app.post("/signup", (req, res) => {

    const { phone, password, referredBy } = req.body;

    // VALIDATE PHONE
    if (!phone || !/^\d{11}$/.test(phone)) {
        return res.status(400).json({ error: "Phone must be 11 digits" });
    }

    if (!password) {
        return res.status(400).json({ error: "Password is required" });
    }

    // CHECK USER EXISTS
    db.query(
        "SELECT id FROM users WHERE phone=?",
        [phone],
        (err, result) => {

            if (err) return res.status(500).json({ error: "DB error" });

            if (result && result.length > 0) {
                return res.status(400).json({ error: "User already exists" });
            }

            const referralCode = generateReferralCode();

            function insertUser(validRef) {

                db.query(
                    `INSERT INTO users 
                    (phone, password, balance, withdrawable_balance, total_invested, total_returns, status, role, referral_code, referred_by,refrerral_amount)
                    VALUES (?, ?, 0, 0, 0, 0, 'active', 'user', ?, ?)`,
                    [phone, password, referralCode, validRef],
                    (err3) => {

                        if (err3) {
                            console.log("SIGNUP ERROR:", err3);
                            return res.status(500).json({ error: "Signup failed" });
                        }

                        db.query(
                            "SELECT id, phone, referral_code, balance FROM users WHERE phone=?",
                            [phone],
                            (err4, users) => {

                                if (err4) {
                                    return res.status(500).json({ error: "DB error" });
                                }

                                return res.json(users[0]);
                            }
                        );
                    }
                );
            }

            if (referredBy) {

                db.query(
                    "SELECT id FROM users WHERE referral_code=?",
                    [referredBy],
                    (err2, refUser) => {

                        const validRef =
                            (!err2 && refUser && refUser.length > 0)
                                ? referredBy
                                : null;

                        insertUser(validRef);
                    }
                );

            } else {
                insertUser(null);
            }
        }
    );
});

// =================user LOGIN =================
app.post("/login", (req, res) => {

    const { phone, password } = req.body;

    // VALIDATION
    if (!phone || !password) {
        return res.status(400).json({ message: "Phone and password required" });
    }

    if (!/^\d{11}$/.test(phone)) {
        return res.status(400).json({ message: "Phone must be 11 digits" });
    }

    db.query(
        "SELECT * FROM users WHERE phone=?",
        [phone],
        (err, result) => {

            if (err) {
                return res.status(500).json({ message: "DB error" });
            }

            if (!result || result.length === 0) {
                return res.status(401).json({ message: "Invalid login" });
            }

            const user = result[0];

            if (user.status === "locked") {
                return res.status(403).json({ message: "Your account has been locked,for inactive investment,please contact the company,or sent message to the whatsapp team. thank you" });
            }

            if (user.password !== password) {
                return res.status(401).json({ message: "Invalid login" });
            }

            const token = jwt.sign(
                {
                    id: user.id,
                    phone: user.phone,
                    role: user.role
                },
                JWT_SECRET,
                { expiresIn: "7d" }
            );

            return res.json({
                token,
                user
            });
        }
    );
});
// ================= RESET PASSWORD =================
app.post("/reset-password", (req, res) => {

    const { phone, newPassword } = req.body;

    // VALIDATE INPUT
    if (!phone || !newPassword) {
        return res.status(400).json({ error: "Phone and new password are required" });
    }

    // VALIDATE PHONE FORMAT
    if (!/^\d{11}$/.test(phone)) {
        return res.status(400).json({ error: "Phone must be exactly 11 digits" });
    }

    // CHECK USER EXISTS
    db.query(
        "SELECT id FROM users WHERE phone=?",
        [phone],
        (err, users) => {

            if (err) {
                return res.status(500).json({ error: "Database error" });
            }

            if (!users || users.length === 0) {
                return res.status(404).json({ error: "User not found" });
            }

            // UPDATE PASSWORD
            db.query(
                "UPDATE users SET password=? WHERE phone=?",
                [newPassword, phone],
                (err2) => {

                    if (err2) {
                        return res.status(500).json({ error: "Update failed" });
                    }

                    return res.json({
                        message: "Password reset successful, please login"
                    });
                }
            );
        }
    );
});

// ================= BALANCE =================
app.get("/balance/:phone", (req, res) => {

    db.query(
        "SELECT balance FROM users WHERE phone=?",
        [req.params.phone],
        (err, result) => {

            if (err) {
                return res.status(500).json({ error: "DB error" });
            }

            if (!result || result.length === 0) {
                return res.status(404).json({ error: "User not found" });
            }

            return res.json({
                balance: result[0].balance || 0
            });
        }
    );
});

app.post("/deposit", upload.single("receipt"), (req, res) => {

    const phone = req.body.phone?.trim();
    const amount = Number(req.body.amount);
    const receipt = req.file ? req.file.filename : null;

    if (!phone || !amount || amount <= 0 || !receipt) {
        return res.status(400).json({ error: "Missing or invalid fields" });
    }
    const depositAmount = Number(amount);

    if (depositAmount < 1000) {
    return res.status(400).send("Minimum deposit is ₦1000");
}
    db.query(
        "SELECT id FROM users WHERE phone = ? LIMIT 1",
        [phone],
        (err, users) => {

            if (err) {
                console.log(err);
                return res.status(500).json({ error: "DB error" });
            }

            if (!users || users.length === 0) {
                return res.status(404).json({ error: "User not found" });
            }

            const userId = users[0].id;

            db.query(
                `INSERT INTO transactions (user_id, type, amount, status, receipt)
                 VALUES (?, 'deposit', ?, 'pending', ?)`,
                [userId, amount, receipt],
                (err2) => {

                    if (err2) {
                        console.log(err2);
                        return res.status(500).json({ error: "Deposit failed" });
                    }

                    return res.json("Deposit submitted for admin approval"
                    );
                }
            );
        }
    );
});
//Admin deposit panel
app.get("/ezeaguuy/deposits", (req, res) => {

    const sql = `
        SELECT 
            t.id,
            t.amount,
            t.status,
            t.receipt,
            u.phone
        FROM transactions t
        LEFT JOIN users u ON t.user_id = u.id
        WHERE t.type = 'deposit'
        ORDER BY t.id DESC
    `;

    db.query(sql, (err, results) => {

        if (err) {
            console.log("DB ERROR:", err);
            return res.status(200).json([]); // NEVER return HTML crash
        }

        return res.status(200).json(results || []);
    });
});

app.post("/ezeaguuy/deposit/approve", (req, res) => {

    const { id } = req.body;

    if (!id) {
        return res.status(400).json({ error: "Missing deposit id" });
    }

    db.query(
        "SELECT * FROM transactions WHERE id=?",
        [id],
        (err, trx) => {

            if (err) {
                return res.status(500).json({ error: "DB error" });
            }

            if (!trx || trx.length === 0) {
                return res.status(404).json({ error: "Transaction not found" });
            }

            const amount = Number(trx[0].amount || 0);
            const user_id = trx[0].user_id;

            // APPROVE TRANSACTION
            db.query(
                "UPDATE transactions SET status='success' WHERE id=?",
                [id]
            );

            // CREDIT USER BALANCE
            db.query(
                "UPDATE users SET balance = balance + ? WHERE id=?",
                [amount, user_id]
            );

            // CHECK REFERRAL INFO
            db.query(
                "SELECT referred_by, referral_bonus_paid FROM users WHERE id=?",
                [user_id],
                (err2, userRes) => {

                    if (err2 || !userRes || userRes.length === 0) {
                        return res.json({ message: "Deposit approved" });
                    }

                    const referredBy = userRes[0].referred_by;
                    const alreadyPaid = userRes[0].referral_bonus_paid;

                    if (!referredBy || alreadyPaid === 1) {
                        return res.json({ message: "Deposit approved" });
                    }

                    db.query(
                        "SELECT id FROM users WHERE referral_code=?",
                        [referredBy],
                        (err3, refUser) => {

                            if (err3 || !refUser || refUser.length === 0) {
                                return res.json({ message: "Deposit approved" });
                            }

                            const refId = refUser[0].id;

                            const commission = amount * 0.11;

                            // CREDIT REFERRER
                            db.query(
    `UPDATE users
     SET referral_amount = referral_amount + ?
     WHERE id=?`,
    [commissionAmount, referrerId],
    (err)=>{
        if(err) console.log(err);
    }
);

                            // 💥 FIXED INSERT (THIS WAS YOUR MAIN BUG)
                            db.query(
                                `INSERT INTO referral_commission 
                                (referrer_id, referred_user_id, deposit_id, deposit_amount, commission_amount)
                                VALUES (?, ?, ?, ?, ?)`,
                                [
                                    refId,
                                    user_id,
                                    id,
                                    amount,
                                    commission
                                ]
                            );

                            // MARK BONUS PAID
                            db.query(
                                "UPDATE users SET referral_bonus_paid=1 WHERE id=?",
                                [user_id]
                            );

                            return res.json({
                                message: "Deposit approved + referral commission saved"
                            });
                        }
                    );
                }
            );
        }
    );
});
//referral history
app.get("/referral-history/:userId", (req, res) => {

    const userId = req.params.userId;

    const sql = `
        SELECT 
            referral_bonus_history.amount,
            referral_bonus_history.created_at,
            referral_bonus_history.referred_user_id
        FROM referral_bonus_history
        WHERE referrer_id = ?
        ORDER BY created_at DESC
    `;

    db.query(sql, [userId], (err, result) => {

        if (err) {
            console.log(err);
            return res.status(200).json([]); // IMPORTANT
        }

        return res.status(200).json(result || []);
    });
});

app.post("/ezeaguuy/deposit/reject", (req, res) => {

    const { id } = req.body;

    if (!id) {
        return res.status(400).json({ error: "Missing deposit id" });
    }

    db.query(
        "UPDATE transactions SET status='rejected' WHERE id=?",
        [id],
        (err) => {

            if (err) {
                return res.status(500).json({ error: "DB error" });
            }

            return res.json({ message: "Deposit rejected" });
        }
    );
});

// ================= BUY / INVEST =================
app.post("/buy", (req, res) => {

    const { phone, amount, wallet, grade } = req.body;
    const investAmount = Number(amount);


    if (!phone || !investAmount || investAmount <= 0 || !grade) {
        return res.status(400).json({
            error: "Invalid input"
        });
    }


    if (!wallet || !["balance", "referral"].includes(wallet)) {
        return res.status(400).json({
            error: "Select valid wallet"
        });
    }


    // VIP PLAN SETTINGS
    const vipPlans = {

        VIP1: { days: 15, rate: 10 },
        VIP2: { days: 30, rate: 15 },
        VIP3: { days: 45, rate: 20 },
        VIP4: { days: 60, rate: 25 },
        VIP5: { days: 75, rate: 30 },
        VIP6: { days: 90, rate: 35 },
        VIP7: { days: 120, rate: 40 },
        VIP8: { days: 150, rate: 45 },
        VIP9: { days: 180, rate: 50 },
        VIP10:{ days: 365, rate: 60 }

    };


    const selectedPlan = vipPlans[grade];


    if (!selectedPlan) {
        return res.status(400).json({
            error: "Invalid investment grade"
        });
    }



    db.query(
        "SELECT balance, referral_amount FROM users WHERE phone=?",
        [phone],
        (err, result) => {

            if (err) {
                return res.status(500).json({
                    error:"DB error"
                });
            }


            if (result.length === 0) {
                return res.status(404).json({
                    error:"User not found"
                });
            }


            const balance = Number(result[0].balance || 0);

            const referralAmount = Number(
                result[0].referral_amount || 0
            );



            // NORMAL WALLET
            if (wallet === "balance") {


                if (balance < investAmount) {
                    return res.status(400).json({
                        error:"Insufficient balance"
                    });
                }


                db.query(
                    `UPDATE users 
                     SET balance = balance - ?,
                     total_invested = total_invested + ?
                     WHERE phone=?`,
                    [
                      investAmount,
                      investAmount,
                      phone
                    ]
                );

            }



            // REFERRAL WALLET
            if (wallet === "referral") {


                if (referralAmount < 10000) {
                    return res.status(400).json({
                        error:
                        "Referral wallet must reach ₦10,000 before use."
                    });
                }


                if (referralAmount < investAmount) {
                    return res.status(400).json({
                        error:
                        "Insufficient referral amount."
                    });
                }



                db.query(
                    `UPDATE users
                     SET referral_amount = referral_amount - ?,
                     total_invested = total_invested + ?
                     WHERE phone=?`,
                    [
                      investAmount,
                      investAmount,
                      phone
                    ]
                );

            }




            // CREATE INVESTMENT
            db.query(
                `INSERT INTO investments
                (
                 phone,
                 amount,
                 interest_rate,
                 status,
                 end_date
                )
                VALUES
                (
                 ?,
                 ?,
                 ?,
                 'active',
                 DATE_ADD(NOW(), INTERVAL ? DAY)
                )`,
                [
                 phone,
                 investAmount,
                 selectedPlan.rate,
                 selectedPlan.days
                ],

                (err2)=>{


                    if(err2){
                        console.log(err2);

                        return res.status(500).json({
                            error:"Investment failed"
                        });
                    }


                    return res.json({
                        message:"Investment successful",
                        grade:grade,
                        wallet_used:wallet,
                        duration:selectedPlan.days+" days"
                    });

                }
            );

        }
    );

});

// ================= TOTAL INVESTED =================
app.get("/total-invested/:phone", (req, res) => {

    db.query(
        "SELECT total_invested FROM users WHERE phone=?",
        [req.params.phone],
        (err, result) => {

            if (err) {
                return res.status(500).json({ error: "DB error" });
            }

            if (!result || result.length === 0) {
                return res.status(404).json({ error: "User not found" });
            }

            return res.json({
                total: Number(result[0].total_invested || 0)
            });
        }
    );
});

// ================= RETURNS =================
app.get("/returns/:phone", (req, res) => {

    db.query(
        "SELECT total_returns FROM users WHERE phone=?",
        [req.params.phone],
        (err, result) => {

            if (err) {
                return res.status(500).json({ error: "DB error" });
            }

            if (!result || result.length === 0) {
                return res.status(404).json({ error: "User not found" });
            }

            return res.json({
                returns: Number(result[0].total_returns || 0)
            });
        }
    );
});

// ================= WITHDRAW =================
app.post("/withdraw", (req, res) => {

    const { phone, amount, pin } = req.body;

    const withdrawAmount = Number(amount);

    if (!phone || !withdrawAmount || !pin) {
        return res.status(400).send("Missing fields");
    }

    // STEP 1: MINIMUM WITHDRAWAL
    if (withdrawAmount < 500) {
        return res.send("Minimum withdrawal is ₦500");
    }

    // STEP 2: GET USER FIRST (IMPORTANT FIX)
    db.query(
        "SELECT * FROM users WHERE phone=?",
        [phone],
        (err2, users) => {

            if (err2) return res.status(500).send("DB error");

            if (!users || users.length === 0) {
                return res.send("User not found");
            }

            const user = users[0];

            // STEP 3: REFERRAL CHECK (FIXED LOCATION)
          // db.query(
    //`SELECT COUNT(*) AS total
     //FROM (
       //  SELECT t.user_id
        // FROM transactions t
        // WHERE t.type = 'deposit'
        // AND t.status = 'success'
        // AND t.amount >= 5000
        // AND t.user_id IN (
         //    SELECT id FROM users WHERE referred_by = ?
        // )
        // GROUP BY t.user_id
    // ) AS qualified_users`,
    //[user.referral_code],
    //(errRef, ref) => {

       // if (errRef) {
          //  console.log("Referral DB error:", errRef);
         //   return res.status(500).send("DB error");
       // }

       // const total = ref?.[0]?.total || 0;

        //if (total < 3) {
         //   return res.status(403).send(
             //   "You must refer at least 3 users with minimum ₦5,000 first deposit each (admin approved)"
           // );
       // }

                    // STEP 4: BANK DETAILs
                    db.query(
                        "SELECT * FROM bank_details WHERE phone=?",
                        [phone],
                        (errBank, bank) => {

                            if (errBank) return res.status(500).send("DB error");

                            if (!bank || bank.length === 0) {
                                return res.send("Please set up bank details first");
                            }

                            const userBank = bank[0];

                            // STEP 5: VERIFY PIN
                            if (userBank.withdraw_pin !== pin) {
                                return res.send("Invalid withdrawal PIN");
                            }

                            // STEP 6: CHECK BALANCE
                            if (user.total_returns < withdrawAmount) {
                                return res.send("Insufficient returns balance");
                            }

                            // STEP 7: FRIDAY WITHDRAWAL LIMIT
const now = new Date();

const day = now.getDay(); // Sunday=0, Monday=1 ... Friday=5
const hour = now.getHours();
const minute = now.getMinutes();


// Check if today is Friday
if (day !== 5) {
    return res.send("Withdrawal is only available every Friday.");
}


// Check time window: 10:00 AM - 3:00 PM
const currentMinutes = (hour * 60) + minute;
const startTime = 10 * 60; // 10:00 AM
const endTime = 15 * 60;   // 3:00 PM


if (currentMinutes < startTime || currentMinutes > endTime) {
    return res.send("Withdrawal is available every Friday from 10:00 AM to 3:00 PM.");
}


// Check if user already withdrew this Friday
db.query(
    `SELECT id FROM transactions 
     WHERE user_id=? 
     AND type='withdraw'
     AND YEARWEEK(created_at, 1)=YEARWEEK(NOW(), 1)`,
    [user.id],
    (err3, existing) => {

        if (err3) return res.status(500).send("DB error");

        if (existing.length > 0) {
            return res.send("You can only withdraw once every Friday.");
        }

                                    // STEP 8: TAX CALCULATION
                                    const tax = withdrawAmount * 0.03;
                                    const finalAmount = withdrawAmount - tax;

                                    // STEP 9: INSERT WITHDRAWAL
                                    db.query(
                                        `INSERT INTO transactions 
                                        (user_id, type, amount, tax, status, bank_name, account_name, account_number) 
                                        VALUES (?, 'withdraw', ?, ?, 'pending', ?, ?, ?)`,
                                        [
                                            user.id,
                                            withdrawAmount,
                                            tax,
                                            userBank.bank_name,
                                            userBank.account_name,
                                            userBank.account_number
                                        ],
                                        (err4) => {

                                            if (err4) {
                                                console.log(err4);
                                                return res.status(500).send("Transaction failed");
                                            }

                                            res.send(`
                                            Withdrawal submitted successfully. Tax deducted ₦${tax.toFixed(2)}. You will receive ₦${finalAmount.toFixed(2)} after approval.s` );
                                        }
                                    );
                                }
                            );
                        }
                    );
                }
            );
        }
    );


// bank details update`
app.post("/bank-details", (req, res) => {

    const { phone, account_name, account_number, bank_name, withdraw_pin } = req.body;

    // VALIDATION
    if (!phone || !account_name || !account_number || !bank_name || !withdraw_pin) {
        return res.status(400).json({ error: "All fields are required" });
    }

    // PIN VALIDATION
    if (!/^\d{4}$/.test(String(withdraw_pin))) {
        return res.status(400).json({ error: "PIN must be 4 digits" });
    }

    db.query(
        "SELECT id FROM bank_details WHERE phone=?",
        [phone],
        (err, result) => {

            if (err) {
                console.log(err);
                return res.status(500).json({ error: "DB error" });
            }

            // UPDATE EXISTING
            if (result && result.length > 0) {

                db.query(
                    `UPDATE bank_details 
                     SET account_name=?, account_number=?, bank_name=?, withdraw_pin=? 
                     WHERE phone=?`,
                    [account_name, account_number, bank_name, withdraw_pin, phone],
                    (err2) => {

                        if (err2) {
                            console.log(err2);
                            return res.status(500).json({ error: "Update failed" });
                        }

                        return res.json({
                            message: "Bank details updated successfully"
                        });
                    }
                );

            } else {

                // INSERT NEW
                db.query(
                    `INSERT INTO bank_details 
                     (phone, account_name, account_number, bank_name, withdraw_pin) 
                     VALUES (?, ?, ?, ?, ?)`,
                    [phone, account_name, account_number, bank_name, withdraw_pin],
                    (err3) => {

                        if (err3) {
                            console.log("BANK INSERT ERROR:", err3);
                            return res.status(500).json({ error: "Insert failed" });
                        }

                        return res.json({
                            message: "Bank details saved successfully"
                        });
                    }
                );
            }
        }
    );
});
// ================= TRANSACTIONS =================
app.get("/transactions/:phone", (req, res) => {

    const phone = req.params.phone;

    const sql = `
        SELECT 
            t.id,
            t.type,
            t.amount,
            t.status,
            t.created_at
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        WHERE u.phone = ?
        ORDER BY t.id DESC
    `;

    db.query(sql, [phone], (err, results) => {

        if (err) {
            console.log(err);
            return res.status(500).json({ error: "DB error" });
        }

        return res.json(results || []);
    });
});


app.post("/ezeaguuy/approve-withdraw", (req, res) => {

    const { id } = req.body;

    if (!id) {
        return res.status(400).send("Missing withdrawal id");
    }

    db.query(
        "SELECT * FROM transactions WHERE id=?",
        [id],
        (err, result) => {

            if (err) return res.status(500).send("DB error");

            if (!result || result.length === 0) {
                return res.status(404).send("Withdrawal not found");
            }
        
            const trx = result[0];
        
            db.query(
                "SELECT * FROM users WHERE id=?",
                [trx.user_id],
                (err2, users) => {

                    if (err2) return res.status(500).send("DB error");

                    if (!users || users.length === 0) {
                        return res.status(404).send("User not found");
                    }

                    const user = users[0];

                    const amount = Number(trx.amount);
                    const tax = Number(trx.tax || 0);

                    // 1. CHECK BALANCE
                    if (Number(user.total_returns) < amount) {
                        return res.status(400).send("Insufficient balance");
                    }

                    // 2. REFERRAL ELIGIBILITY CHECK (FIXED)
                    //db.query(
                       // `SELECT COUNT(*) AS total 
                        // FROM users 
                        // WHERE referred_by = ? 
                         //AND first_deposit >= 5000`,
                       // [user.referral_code],   // ✅ FIXED HERE
                       // (err3, ref) => {

                           // if (err3) {
                           //     return res.status(500).send("Referral check error");
                           // }

                           // if (ref[0].total < 2) {
                              //  return res.status(403).send(
                              //      "User not eligible for withdrawal (need 3 referrals)"
                              //  );
                            //}

                            // 3. DEDUCT USER BALANCE
                            db.query(
                                "UPDATE users SET total_returns = total_returns - ? WHERE id=?",
                                [amount, user.id],
                                (err4) => {

                                    if (err4) {
                                        console.log("Deduction error:", err4);
                                        return res.status(500).send("Deduction failed");
                                    }

                                    // 4. ADD TAX TO ADMIN VAULT
                                    db.query(
                                        "UPDATE admin_vault SET total_balance = total_balance + ? WHERE id=1",
                                        [tax],
                                        (err5) => {

                                            if (err5) {
                                                console.log("Vault error:", err5);
                                            }

                                            // 5. MARK APPROVED
                                            db.query(
                                                "UPDATE transactions SET status='approved' WHERE id=?",
                                                [id],
                                                (err6) => {

                                                    if (err6) {
                                                        console.log("Status error:", err6);
                                                        return res.status(500).send("Status update failed");
                                                    }

                                                    return res.send("Withdrawal approved successfully");
                                                }
                                            );
                                        }
                                    );
                                }
                            );
                        }
                    );
                }
            );
        }
    );


app.post("/ezeaguuy/withdrawals/approve", (req, res) => {

    const { id } = req.body;

    if (!id) {
        return res.status(400).json({ error: "Missing withdrawal id" });
    }

    db.query(
        `SELECT t.id, t.amount, t.user_id, u.total_returns
         FROM transactions t
         JOIN users u ON t.user_id = u.id
         WHERE t.id=?`,
        [id],
        (err, result) => {

            if (err) {
                console.log("DB ERROR:", err);
                return res.status(500).json({ error: "DB error" });
            }

            if (!result || result.length === 0) {
                return res.status(404).json({ error: "Transaction not found" });
            }

            const trx = result[0];

            const amount = Number(trx.amount || 0);
            const balance = Number(trx.total_returns || 0);

            // RULE 1: MINIMUM WITHDRAWAL AMOUNT
            if (amount < 500) {
                return res.status(400).json({ error: "Minimum withdrawal is ₦500" });
            }

            // RULE 2: CHECK FUNDS
            if (balance < amount) {
                return res.status(400).json({ error: "Insufficient returns balance" });
            }

            // STEP 1: DEDUCT RETURNS FIRST
            db.query(
                "UPDATE users SET total_returns = total_returns - ? WHERE id=?",
                [amount, trx.user_id],
                (err1) => {

                    if (err1) {
                        console.log("UPDATE ERROR:", err1);
                        return res.status(500).json({ error: "Failed to deduct returns" });
                    }

                    // STEP 2: UPDATE TRANSACTION STATUS
                    db.query(
                        "UPDATE transactions SET status='success' WHERE id=?",
                        [id],
                        (err2) => {

                            if (err2) {
                                console.log("STATUS ERROR:", err2);
                                return res.status(500).json({ error: "Failed to update status" });
                            }

                            return res.json({
                                message: "Withdrawal approved successfully"
                            });
                        }
                    );
                }
            );
        }
    );
});

app.get("/returns/:phone", (req, res) => {

    db.query(
        "SELECT total_returns FROM users WHERE phone=?",
        [req.params.phone],
        (err, result) => {

            if (err) {
                return res.status(500).json({ error: "DB error" });
            }

            if (!result || result.length === 0) {
                return res.json({ total: 0 });
            }

            return res.json({
                total: Number(result[0].total_returns || 0)
            });
        }
    );
});

app.post("/ezeaguuy/withdrawals/reject", (req, res) => {

    const { id } = req.body;

    if (!id) {
        return res.status(400).json({ error: "Missing withdrawal id" });
    }

    db.query(
        "UPDATE transactions SET status='rejected' WHERE id=?",
        [id],
        (err) => {

            if (err) {
                return res.status(500).json({ error: "DB error" });
            }

            return res.json({
                message: "Withdrawal rejected"
            });
        }
    );
});

// ADMIN WITHDRAWALS LIST
app.get("/ezeaguuy/withdrawals", (req, res) => {

    const sql = `
        SELECT 
            t.id,
            t.amount,
            t.status,
            t.created_at,
            u.phone,
            b.account_name,
            b.account_number,
            b.bank_name,
            b.withdraw_pin
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN bank_details b ON b.phone = u.phone
        WHERE t.type = 'withdraw'
        ORDER BY t.id DESC
    `;

    db.query(sql, (err, results) => {

        if (err) {
            console.log(err);
            return res.status(500).json({ error: "DB error" });
        }

        return res.json(results || []);
    });
});

// ADMIN LOGIN
app.post("/ezeaguuy/login", (req, res) => {

    const { phone, password } = req.body;

    if (!phone || !password) {
        return res.status(400).json({ error: "Phone and password required" });
    }

    db.query(
        "SELECT * FROM users WHERE phone=? AND password=? AND role='admin' LIMIT 1",
        [phone, password],
        (err, result) => {

            if (err) {
                console.log("ADMIN LOGIN ERROR:", err);
                return res.status(500).json({ error: "DB error" });
            }

            if (!result || result.length === 0) {
                return res.status(401).json({ error: "Invalid admin login" });
            }

            const admin = result[0];

            const token = "admin_" + admin.id + "_" + Date.now();

            return res.json({
                success: true,
                token,
                user: {
                    id: admin.id,
                    phone: admin.phone,
                    role: admin.role
                }
            });
        }
    );
});

//admin users
app.post("/ezeaguuy/users", (req, res) => {

    const { phone, password } = req.body;

    if (!phone || !password) {
        return res.status(400).json({ error: "Missing admin credentials" });
    }

    db.query(
        "SELECT * FROM users WHERE phone=? AND password=? AND role='admin' LIMIT 1",
        [phone, password],
        (err, result) => {

            if (err) {
                return res.status(500).json({ error: "DB error" });
            }

            if (!result || result.length === 0) {
                return res.status(403).json({ error: "Unauthorized" });
            }

            db.query(
                "SELECT id, phone, balance, status FROM users ORDER BY id DESC",
                (err2, users) => {

                    if (err2) {
                        return res.status(500).json({ error: "DB error" });
                    }

                    return res.json(users || []);
                }
            );
        }
    );
});

app.get("/interest-history", (req, res) => {

    const { phone } = req.query;

    if (!phone) {
        return res.status(400).json({ error: "Phone is required" });
    }

    db.query(
        "SELECT * FROM interest_history WHERE phone=? ORDER BY id DESC",
        [phone],
        (err, results) => {

            if (err) {
                return res.status(500).json({ error: "DB error" });
            }

            return res.json(results || []);
        }
    );
});

// ADMIN USER BANK DETAILS
app.get("/ezeaguuy/user-bank/:phone", (req, res) => {

    const phone = req.params.phone;

    db.query(
        "SELECT account_name, account_number, bank_name FROM bank_details WHERE phone=?",
        [phone],
        (err, result) => {

            if (err) {
                return res.status(500).json({ error: "DB error" });
            }

            if (!result || result.length === 0) {
                return res.json(null);
            }

            return res.json(result[0]);
        }
    );
});


//admin create bonus section
app.post("/ezeaguuy/create-bonus", (req, res) => {

    const { amount, maxUsers, expiryHours, expiryMinutes } = req.body;

    if (!amount || !maxUsers) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    const code = "BONUS-" + Math.random().toString(36).substring(2, 8).toUpperCase();

    const totalMinutes =
        (Number(expiryHours || 0) * 60) + Number(expiryMinutes || 0);

    const expiresAt = new Date(Date.now() + totalMinutes * 60000);

    db.query(
        `INSERT INTO bonus_codes 
        (code, amount, max_users, used_count, expires_at)
        VALUES (?, ?, ?, 0, ?)`,
        [code, amount, maxUsers, expiresAt],
        (err) => {

            if (err) {
                console.log(err);
                return res.status(500).json({ error: "Failed to create bonus" });
            }

            return res.json({
                code,
                amount: Number(amount),
                maxUsers: Number(maxUsers),
                expiresAt
            });
        }
    );
});

app.post("/claim-bonus", (req, res) => {

    const { userId, code } = req.body;

    if (!userId || !code) {
        return res.status(400).json({ error: "Missing data" });
    }

    db.query(
        "SELECT * FROM bonus_codes WHERE code=?",
        [code],
        (err, result) => {

            if (err) {
                console.log(err);
                return res.status(500).json({ error: "DB error" });
            }

            if (!result || result.length === 0) {
                return res.status(404).json({ error: "Invalid code" });
            }

            const bonus = result[0];

            const now = Date.now();
            const expiry = new Date(bonus.expires_at).getTime();

            if (isNaN(expiry)) {
                return res.status(400).json({ error: "Invalid expiry time" });
            }

            if (expiry <= now) {
                return res.status(400).json({ error: "Code expired" });
            }

            if (bonus.used_count >= bonus.max_users) {
                return res.status(400).json({ error: "Code already fully used" });
            }

            db.query(
                "SELECT * FROM bonus_claims WHERE user_id=? AND code=?",
                [userId, code],
                (err2, used) => {

                    if (err2) {
                        return res.status(500).json({ error: "DB error" });
                    }

                    if (used && used.length > 0) {
                        return res.status(400).json({ error: "You already used this code" });
                    }

                    // ADD BALANCE
                    db.query(
                        "UPDATE users SET balance = balance + ? WHERE id=?",
                        [bonus.amount, userId]
                    );

                    // LOG CLAIM
                    db.query(
                        "INSERT INTO bonus_claims (user_id, code, amount) VALUES (?, ?, ?)",
                        [userId, code, bonus.amount]
                    );

                    // INCREASE COUNT
                    db.query(
                        "UPDATE bonus_codes SET used_count = used_count + 1 WHERE code=?",
                        [code]
                    );

                    return res.json({
                        message: `🎉 Congratulations! You received ₦${bonus.amount}`
                    });
                }
            );
        }
    );
});
//check active investment for bonus box
app.get("/user/has-active-investment/:phone", (req, res) => {

    db.query(
        `SELECT id FROM investments 
         WHERE phone=? AND status='active'`,
        [req.params.phone],
        (err, result) => {

            if (err) {
                return res.status(500).json({ error: "DB error" });
            }

            return res.json({
                active: result && result.length > 0
            });
        }
    );
});

// ADMIN ALL USERS
app.get("/ezeaguuy/all-users", (req, res) => {

    const sql = `
        SELECT id, phone,status, balance
        FROM users
        ORDER BY id DESC
    `;

    db.query(sql, (err, result) => {

        if (err) {
            console.log(err);
            return res.status(500).json({ error: "DB error" });
        }

        return res.json(result || []);
    });
});

// ADMIN TOGGLE USER STATUS
app.post("/ezeaguuy/toggle-user-status", (req, res) => {

    const { id, status } = req.body;

    if (!id || !status) {
        return res.status(400).json({ error: "Missing data" });
    }

    db.query(
        "UPDATE users SET status=? WHERE id=?",
        [status, id],
        (err) => {

            if (err) {
                return res.status(500).json({ error: "DB error" });
            }

            return res.json({
                message: "User status updated"
            });
        }
    );
});
//referral commission
app.get("/referral-commission/:userId", (req, res) => {

    const userId = req.params.userId;

    const sql = `
        SELECT 
            referral_commission.commission_amount,
            referral_commission.deposit_amount,
            referral_commission.created_at,
            users.phone AS referred_user
        FROM referral_commission
        INNER JOIN users 
            ON users.id = referral_commission.referred_user_id
        WHERE referral_commission.referrer_id = ?
        ORDER BY referral_commission.created_at DESC
    `;

    db.query(sql, [userId], (err, result) => {

        if (err) {
            console.log("Referral commission DB Error:", err);
            return res.status(500).json([]);
        }

        return res.json(result || []);
    });
});
//fetch all investment by admin
app.get("/investments/all", (req, res) => {

    const sql = `
        SELECT 
            id,
            phone,
            amount,
            interest_rate,
            start_date,
            end_date,
            status
        FROM investments 
        ORDER BY start_date DESC
    `;

    db.query(sql, (err, result) => {

        if (err) {
            console.log("Investment fetch error:", err);
            return res.status(500).json([]);
        }

        return res.json(result);
    });
});
// user active and inactive investment

//Ai chat
const axios = require("axios");

app.post("/chat-ai", async (req, res) => {

    const { message, userId } = req.body;

    if (!message) {
        return res.status(400).json({ error: "Message required" });
    }

    try {

        const response = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: `
You are Smartearn AI support assistant.

Rules:
- Only answer questions about deposit, investment, withdrawal, referral system.
- Do NOT approve transactions.
- Do NOT give financial manipulation advice.
- Be short, clear, and helpful.
                        `
                    },
                    {
                        role: "user",
                        content: message
                    }
                ]
            },
            {
                headers: {
                    "Authorization": `Bearer YOUR_OPENAI_API_KEY`,
                    "Content-Type": "application/json"
                }
            }
        );

        const aiReply = response.data.choices[0].message.content;

        res.json({ reply: aiReply });

    } catch (err) {
        console.log(err.message);
        res.status(500).json({ error: "AI service error" });
    }
});
//user sends message
app.post("/chat/send", (req, res) => {

    const { user_id, message } = req.body;

    db.query(
        "INSERT INTO chat_messages (user_id, message) VALUES (?, ?)",
        [user_id, message],
        (err) => {

            if (err) return res.status(500).json({ error: "Failed" });

            res.json({ message: "Sent" });
        }
    );
});
//admin gets all message
app.get("/admin/chats", (req, res) => {

    db.query(
        `SELECT chat_messages.*, users.phone
         FROM chat_messages
         JOIN users ON users.id = chat_messages.user_id
         ORDER BY chat_messages.created_at DESC`,
        (err, result) => {

            if (err) return res.status(500).json([]);

            res.json(result || []);
        }
    );
});
//admin reples
app.post("/admin/chat/reply", (req, res) => {

    const { id, reply } = req.body;

    db.query(
        "UPDATE chat_messages SET reply=?, is_admin_reply=1 WHERE id=?",
        [reply, id],
        (err) => {

            if (err) return res.status(500).json({ error: "Failed" });

            res.json({ message: "Replied" });
        }
    );
});
//for users
app.get("/api/investments/expired", (req, res) => {

    const phone = req.query.phone;

    // 🔥 VALIDATION
    if (!phone) {
        return res.status(400).json({
            success: false,
            message: "Phone is required"
        });
    }

    db.query(
        `SELECT 
            id,
            phone,
            amount,
            interest_rate,
            start_date,
            end_date,
            status
         FROM investments 
         WHERE phone=? 
         AND (
                LOWER(TRIM(status)) = 'expired'
                OR end_date <= NOW()
             )
         ORDER BY end_date DESC`,
        [phone],
        (err, results) => {

            if (err) {
                console.log("❌ Expired investments error:", err);

                return res.status(500).json({
                    success: false,
                    message: "Database error"
                });
            }

            return res.json(results || []);
        }
    );
});

//active for users

app.get("/api/investments/active", (req, res) => {

    const phone = req.query.phone;

    // 🔥 SAFETY CHECK
    if (!phone) {
        return res.status(400).json({
            success: false,
            message: "Phone is required"
        });
    }

    db.query(
        `SELECT 
            id,
            phone,
            amount,
            interest_rate,
            start_date,
            end_date,
            status
         FROM investments
         WHERE phone = ?
         AND LOWER(TRIM(status)) = 'active'
         AND end_date > NOW()
         ORDER BY start_date DESC`,
        [phone],
        (err, results) => {

            if (err) {
                console.log("❌ ACTIVE INVESTMENT DB ERROR:", err);

                return res.status(500).json({
                    success: false,
                    message: "Database error"
                });
            }

            return res.json(results || []);
        }
    );
});

//StartUP process
app.post("/api/startup/invest", (req, res) => {

    const { phone } = req.body;
    const amount = 5000;

    if (!phone) {
        return res.status(400).json({
            success: false,
            message: "Phone is required"
        });
    }

    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 21);

    db.query(
        `INSERT INTO startup_investments 
        (phone, amount, status, created_at, end_date)
        VALUES (?, ?, 'pending', NOW(), ?)`,
        [phone, amount, endDate],
        (err, result) => {

            if (err) {
                console.log("STARTUP INSERT ERROR:", err); // 🔥 VERY IMPORTANT
                return res.status(500).json({
                    success: false,
                    message: "Error creating startup investment"
                });
            }

            return res.json({
                success: true,
                message: "Startup investment submitted successfully"
            });
        }
    );
});

//startup active investment
app.get("/api/startup/active", (req, res) => {

    const phone = req.query.phone;

    db.query(
        `SELECT * FROM investments
         WHERE phone=? 
         AND status='active'
         AND plan_type='startup'
         AND end_date > NOW()`,
        [phone],
        (err, result) => {

            if (err) return res.json([]);

            res.json(result || []);
        }
    );
});

// startup expired investment

app.get("/api/startup/expired", (req, res) => {

    const phone = req.query.phone;

    db.query(
        `SELECT * FROM investments
         WHERE phone=? 
         AND status='expired'
         AND plan_type='startup'
         AND end_date > NOW()`,
        [phone],
        (err, result) => {

            if (err) return res.json([]);

            res.json(result || []);
        }
    );
});
//startup interest
app.get("/api/startup/total-interest", (req, res) => {

    const phone = req.query.phone;

    db.query(
        `SELECT SUM(interest) as total 
         FROM interest_history 
         WHERE phone=?`,
        [phone],
        (err, result) => {

            if (err) return res.json({ total: 0 });

            res.json({ total: result[0].total || 0 });
        }
    );
});
//start admin approve deposit
app.post("/api/ezeaguuy/startup/approve", (req, res) => {

    const { id } = req.body;

    db.query(
        `UPDATE startup_requests 
         SET status='approved'
         WHERE id=?`,
        [id],
        (err) => {

            if (err) return res.status(500).json({ message: "Error" });

            // MOVE TO ACTIVE INVESTMENTS
            db.query(`
                SELECT * FROM startup_requests WHERE id=?`,
                [id],
                (err2, result) => {

                    const data = result[0];

                    const end_date = new Date();
                    end_date.setDate(end_date.getDate() + 21);

                    db.query(
                        `INSERT INTO investments 
                        (phone, amount, interest_rate, status, start_date, end_date, plan_type)
                        VALUES (?, ?, 10, 'active', NOW(), ?, 'startup')`,
                        [data.phone, data.amount, end_date]
                    );
                }
            );

            res.json({ message: "Approved" });
        }
    );
});
// startup referral count
app.get("/api/startup/referrals", (req, res) => {

    const phone = req.query.phone;

    db.query(`
        SELECT COUNT(*) AS count FROM referrals WHERE referrer=?`,
        [phone],
        (err, result) => {

            if (err) return res.json({ count: 0 });

            res.json({ count: result[0].count });
        }
    );
});
//pending approve deposit
app.post("/api/startup/pending", upload.single("receipt"), (req, res) => {

    const { phone, amount } = req.body;
    const receipt = req.file.filename;

    db.query(
        `INSERT INTO startup_requests 
        (phone, amount, receipt, status, created_at)
        VALUES (?, ?, ?, 'pending', NOW())`,
        [phone, amount, receipt],
        (err) => {

            if (err) {
                return res.status(500).json({ message: "Request failed" });
            }

            res.json({
                message: "Startup investment sent for admin approval"
            });
        }
    );
});

// ===============================
// AVIATOR GAME MODULE
// ===============================


// ===============================
// SOCKET.IO SERVER
// ===============================

const PORT = process.env.PORT || 3000;

const http = require("http");

const server = http.createServer(app);

const { Server } = require("socket.io");


const io = new Server(server,{

    cors:{
        origin:"*"
    }

});




// ===============================
// AVIATOR VARIABLES
// ===============================

let currentRound = null;

let currentRoundId = null;

let multiplier = 1.00;

let gameRunning = false;

let bettingOpen = false;




// ===============================
// GENERATE CRASH POINT
// ===============================

function generateCrashPoint(){

    let random = Math.random();

    let crash;


    if(random < 0.30){

        // Low multiplier
        crash = 1.20 + Math.random() * 0.005;


    } 
    else if(random < 0.95){

        // Medium multiplier
        crash = 2.50 + Math.random() * 0.05;


    } 
    else {

        // High multiplier
        crash = 5 + Math.random() * 0.01;

    }


    return Number(crash.toFixed(2));

}

// ===============================
// START AVIATOR ROUND
// WITH 15 SECOND BETTING TIME
// ===============================

function startAviatorRound(){


    gameRunning = false;

    bettingOpen = false;



    const crashPoint = generateCrashPoint();

    const roundCode = "AVT-" + Date.now();



    db.query(

    `
    INSERT INTO aviator_rounds

    (
    round_code,
    crash_point,
    status
    )

    VALUES(?,?,?)

    `,

    [
    roundCode,
    crashPoint,
    "waiting"
    ],


    (err,result)=>{


        if(err){

            console.log(
            "Round creation error:",
            err
            );

            return;

        }



        currentRoundId = result.insertId;



        currentRound = {

            id: currentRoundId,

            roundCode: roundCode,

            crashPoint: crashPoint,

            multiplier:1

        };



        let countdown = 15;



        bettingOpen = true;



        io.emit("bettingStart",{

            roundId:currentRoundId,

            seconds:countdown

        });





        const countdownTimer = setInterval(()=>{


            countdown--;



            io.emit("bettingCountdown",{

                seconds:countdown

            });





            if(countdown <= 0){


                clearInterval(countdownTimer);


                bettingOpen = false;


                createRunningRound();


            }



        },1000);



    });


}





// ===============================
// START FLIGHT AFTER BETTING
// ===============================

function createRunningRound(){



db.query(

`
UPDATE aviator_rounds

SET status='running'

WHERE id=?

`,

[
currentRoundId

],


(err)=>{


if(err){

console.log(err);

return;

}




multiplier = 1.00;


gameRunning = true;


bettingOpen = false;



console.log(

"NEW AVIATOR ROUND:",

currentRoundId,

"CRASH:",

currentRound.crashPoint

);





io.emit("gameStart",{


roundId:currentRoundId,

roundCode:currentRound.roundCode,

multiplier:"1.00x"


});





startMultiplier(currentRound.crashPoint);



});


}

// ===============================
// MULTIPLIER ENGINE
// ===============================

function startMultiplier(crashPoint){


const interval = setInterval(()=>{


if(!gameRunning){

clearInterval(interval);

return;

}



multiplier += 1;



currentRound.multiplier =
Number(multiplier.toFixed(2));




io.emit("multiplier",{


value:

multiplier.toFixed(2)+"x"


});






if(multiplier >= crashPoint){



clearInterval(interval);



gameRunning = false;

bettingOpen = false;





db.query(

`
UPDATE aviator_rounds

SET

status='crashed',

crashed_at=NOW()

WHERE id=?

`,

[
currentRoundId
]

);






db.query(

`
UPDATE aviator_bets

SET status='lost'

WHERE round_id=?

AND status='active'

`,

[
currentRoundId
]

);





io.emit("crashed",{


value:

crashPoint+"x"


});





console.log(

"CRASHED AT:",

crashPoint

);






setTimeout(()=>{


startAviatorRound();


},5000);




}



},100);



}
// ===============================
// FUND AVIATOR GAME WALLET
// ===============================


app.post("/aviator/fund",(req,res)=>{


const {phone,amount}=req.body;



if(!phone || !amount){

return res.status(400).json({

success:false,

message:"Phone and amount are required"

});

}



const fundAmount = Number(amount);



if(fundAmount <= 0){

return res.status(400).json({

success:false,

message:"Invalid amount"

});

}





db.getConnection((err,connection)=>{


if(err){

return res.status(500).json({

success:false,

message:"Database connection error"

});

}





connection.beginTransaction((err)=>{


if(err){

connection.release();

return res.status(500).json({

success:false,

message:"Transaction error"

});

}





// Remove from main wallet

connection.query(

`
UPDATE users

SET balance = balance - ?

WHERE phone=?

AND balance >= ?

`,

[
fundAmount,
phone,
fundAmount
],


(err,result)=>{


if(err){

return connection.rollback(()=>{

connection.release();

res.status(500).json({

success:false,

message:"Wallet update failed"

});

});

}





if(result.affectedRows===0){

return connection.rollback(()=>{

connection.release();

res.status(400).json({

success:false,

message:"Insufficient balance"

});

});

}





// Add to game wallet

connection.query(

`
INSERT INTO game_wallet

(phone,balance)

VALUES(?,?)

ON DUPLICATE KEY UPDATE

balance = balance + ?

`,

[
phone,
fundAmount,
fundAmount
],


(err)=>{


if(err){

return connection.rollback(()=>{

connection.release();

res.status(500).json({

success:false,

message:"Game wallet failed"

});

});

}





// Save transaction history

connection.query(

`
INSERT INTO game_transactions

(phone,type,amount,status)

VALUES(?,?,?,?)

`,

[
phone,
"fund",
fundAmount,
"success"
],


(err)=>{


if(err){

return connection.rollback(()=>{

connection.release();

res.status(500).json({

success:false,

message:"History failed"

});

});

}





connection.commit((err)=>{


if(err){

return connection.rollback(()=>{

connection.release();

res.status(500).json({

success:false,

message:"Commit failed"

});

});

}





connection.release();



res.json({

success:true,

message:"Game wallet funded successfully",

amount:fundAmount

});



});


});


});


});


});


});


});

// ===============================
// PLACE BET
// ===============================

app.post("/aviator/bet",(req,res)=>{


const {phone,amount}=req.body;



if(!phone || !amount){

return res.status(400).json({

success:false,

message:"Phone and amount required"

});

}




// Only allow betting during countdown

if(!bettingOpen){

return res.status(400).json({

success:false,

message:"Betting closed"

});

}




const betAmount = Number(amount);



if(isNaN(betAmount) || betAmount <= 0){

return res.status(400).json({

success:false,

message:"Invalid bet amount"

});

}





db.getConnection((err,connection)=>{


if(err){

return res.status(500).json({

success:false,

message:"Database connection error"

});

}





connection.beginTransaction((err)=>{


if(err){

connection.release();

return res.status(500).json({

success:false,

message:"Transaction error"

});

}





// Deduct from game wallet

connection.query(

`
UPDATE game_wallet

SET balance = balance - ?

WHERE phone=?

AND balance >= ?

`,

[
betAmount,
phone,
betAmount
],


(err,result)=>{


if(err){

return connection.rollback(()=>{

connection.release();

res.status(500).json({

success:false,

message:"Wallet error"

});

});

}





if(result.affectedRows===0){

return connection.rollback(()=>{

connection.release();

res.status(400).json({

success:false,

message:"Insufficient game balance"

});

});

}





// Save bet

connection.query(

`
INSERT INTO aviator_bets

(
phone,
amount,
round_id,
status
)

VALUES(?,?,?,'active')

`,

[
phone,
betAmount,
currentRoundId
],


(err)=>{


if(err){

return connection.rollback(()=>{

connection.release();

res.status(500).json({

success:false,

message:"Bet save failed"

});

});

}





connection.commit((err)=>{


if(err){

return connection.rollback(()=>{

connection.release();

res.status(500).json({

success:false,

message:"Commit failed"

});

});

}





connection.release();



res.json({

success:true,

message:"Bet placed successfully",

roundId:currentRoundId

});



});



});


});


});


});


});
// ===============================
// SOCKET CONNECTION
// ===============================


io.on("connection",(socket)=>{


console.log(

"Player connected:",

socket.id

);



socket.on("disconnect",()=>{


console.log(

"Player disconnected:",

socket.id

);


});


});





// ===============================
// CASHOUT
// ===============================


app.post("/aviator/cashout",(req,res)=>{


const {phone}=req.body;



if(!phone){

return res.status(400).json({

success:false,

message:"Phone required"

});

}





// Cashout only while plane is flying

if(!gameRunning){

return res.status(400).json({

success:false,

message:"Round already crashed"

});

}





db.query(

`
SELECT *

FROM aviator_bets

WHERE phone=?

AND round_id=?

AND status='active'

LIMIT 1

`,

[
phone,
currentRoundId
],


(err,result)=>{


if(err){

return res.status(500).json({

success:false,

message:"Database error"

});

}





if(result.length===0){

return res.status(400).json({

success:false,

message:"No active bet"

});

}





const bet = result[0];





const cashoutMultiplier =

Number(multiplier.toFixed(2));





const winAmount =

Number(

(bet.amount * cashoutMultiplier)

.toFixed(2)

);






db.getConnection((err,connection)=>{


if(err){

return res.status(500).json({

success:false,

message:"Database connection error"

});

}





connection.beginTransaction((err)=>{


if(err){

connection.release();

return res.status(500).json({

success:false,

message:"Transaction error"

});

}





// Update bet status

connection.query(

`
UPDATE aviator_bets

SET

cashout_multiplier=?,

profit=?,

status='won'

WHERE id=?

AND status='active'

`,

[
cashoutMultiplier,
winAmount,
bet.id
],



(err,update)=>{


if(err){

return connection.rollback(()=>{

connection.release();

res.status(500).json({

success:false,

message:"Bet update failed"

});

});

}





if(update.affectedRows===0){

return connection.rollback(()=>{

connection.release();

res.status(400).json({

success:false,

message:"Already cashed out"

});

});

}





// Add winnings

connection.query(

`
UPDATE game_wallet

SET balance = balance + ?

WHERE phone=?

`,

[
winAmount,
phone
],



(err)=>{


if(err){

return connection.rollback(()=>{

connection.release();

res.status(500).json({

success:false,

message:"Wallet update failed"

});

});

}





// Save win history

connection.query(

`
INSERT INTO game_transactions

(phone,type,amount,status)

VALUES(?,?,?,?)

`,

[
phone,
"win",
winAmount,
"success"

],



(err)=>{


if(err){

return connection.rollback(()=>{

connection.release();

res.status(500).json({

success:false,

message:"History failed"

});

});

}





connection.commit((err)=>{


if(err){

return connection.rollback(()=>{

connection.release();

res.status(500).json({

success:false,

message:"Commit failed"

});

});

}





connection.release();



res.json({

success:true,

message:"Cashout successful",

data:{


betAmount:bet.amount,


multiplier:

cashoutMultiplier+"x",


winningAmount:

winAmount


}


});



});



});


});


});


});


});


});


});

app.get("/aviator/wallet/:phone",(req,res)=>{

const phone = req.params.phone;


db.query(

`
SELECT balance 
FROM game_wallet
WHERE phone=?

`,

[phone],

(err,result)=>{


if(err){

return res.status(500).json({

success:false,

message:"Database error"

});

}


if(result.length===0){

return res.json({

success:true,

balance:0

});

}


res.json({

success:true,

balance:result[0].balance

});


});


});
// ===============================
// START AVIATOR + SERVER
// ===============================


// Start first countdown

startAviatorRound();




// Start Render server

server.listen(PORT,()=>{


console.log(

"Server running on port",

PORT

);


});