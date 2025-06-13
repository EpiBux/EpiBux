// --- IMPORTS ---
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// --- APP INITIALIZATION & MIDDLEWARE ---
const app = express();
app.use(cors());
app.use(express.json());

// --- FIREBASE ADMIN SDK INITIALIZATION ---
try {
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!serviceAccountBase64) throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE_64 is not set.");
    const serviceAccountJson = Buffer.from(serviceAccountBase64, 'base64').toString('utf-8');
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("✅ Firebase Admin SDK initialized successfully.");
} catch (e) {
    console.error("❌ FATAL: Could not initialize Firebase Admin SDK.", e.message);
    process.exit(1);
}

const db = admin.firestore();
const auth = admin.auth();
const { FieldValue } = admin.firestore;

// --- FRONTEND SERVING ROUTES ---
app.get('/firebase-config.js', (req, res) => { if (!process.env.PUBLIC_FIREBASE_API_KEY) return res.status(500).send("// Server error: Firebase public keys are not set."); res.type('.js'); const scriptContent = ` export const firebaseConfig = { apiKey: "${process.env.PUBLIC_FIREBASE_API_KEY}", authDomain: "${process.env.PUBLIC_FIREBASE_AUTH_DOMAIN}", projectId: "${process.env.PUBLIC_FIREBASE_PROJECT_ID}", storageBucket: "${process.env.PUBLIC_FIREBASE_STORAGE_BUCKET}", messagingSenderId: "${process.env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID}", appId: "${process.env.PUBLIC_FIREBASE_APP_ID}", measurementId: "${process.env.PUBLIC_FIREBASE_MEASUREMENT_ID}" }; export const GLITCH_PROJECT_URL = "${process.env.GLITCH_PROJECT_URL}"; `; res.send(scriptContent); });
app.use(express.static(path.join(__dirname, 'public')));


// --- SECURE BACKEND API ROUTES ---

app.post('/create-post', async (req, res) => {
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    const { title, description, price, link, isInfinite, stock } = req.body;

    if (!idToken || !title || !description || !link || price == null) {
        return res.status(400).json({ error: 'Missing required fields.' });
    }
    if (isInfinite === false && (!stock || stock <= 0 || !Number.isInteger(stock))) {
        return res.status(400).json({ error: 'A valid stock number is required for non-infinite items.' });
    }
    if (isNaN(price) || !Number.isInteger(price) || price < 0 || price > 1000) {
        return res.status(400).json({ error: 'Price is invalid. Must be a whole number between 0 and 1,000.' });
    }

    try {
        const decodedToken = await auth.verifyIdToken(idToken);
        const userDoc = await db.collection('users').doc(decodedToken.uid).get();
        if (!userDoc.exists) { throw new Error("User creating post not found."); }
        const username = userDoc.data().username;
        
        const newPostData = {
            title, description, price, link, isInfinite,
            stock: isInfinite ? null : stock,
            sellerUid: decodedToken.uid,
            sellerUsername: username,
            isAccepted: false,
            createdAt: FieldValue.serverTimestamp()
        };
        
        await db.collection('marketplace').add(newPostData);

        return res.status(200).json({ message: 'Submitted for review, notify an admin so they can accept it.' });

    } catch (error) {
        console.error("Create Post Error:", error);
        return res.status(400).json({ error: 'Failed to create post. ' + error.message });
    }
});

app.post('/buy-item', async (req, res) => {
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    const { postId } = req.body;
    if (!idToken || !postId) return res.status(400).json({ error: 'Token or Post ID is missing.' });

    try {
        const decodedToken = await auth.verifyIdToken(idToken);
        const buyerUid = decodedToken.uid;
        const postRef = db.collection('marketplace').doc(postId);
        const buyerRef = db.collection('users').doc(buyerUid);

        const result = await db.runTransaction(async (t) => {
            const postDoc = await t.get(postRef);
            if (!postDoc.exists) throw new Error("This item is no longer available.");
            
            const postData = postDoc.data();
            if (postData.isAccepted !== true) throw new Error("This item is not available for purchase yet.");

            if (postData.isInfinite === false) {
                if (!postData.stock || postData.stock <= 0) {
                    throw new Error("This item is out of stock.");
                }
            }
            
            const price = postData.price;
            const sellerUid = postData.sellerUid;
            if (buyerUid === sellerUid) throw new Error("You cannot buy your own item.");

            const buyerDoc = await t.get(buyerRef);
            if (!buyerDoc.exists) throw new Error("Your user profile could not be found.");
            const buyerUsername = buyerDoc.data().username;
            if (buyerDoc.data().balance < price) throw new Error("You have insufficient funds for this purchase.");
            
            const sellerRef = db.collection('users').doc(sellerUid);

            t.update(buyerRef, { balance: FieldValue.increment(-price) });
            t.update(sellerRef, { balance: FieldValue.increment(price) });
            
            const notificationRef = db.collection('notifications').doc();
            t.set(notificationRef, {
                sellerUid: sellerUid,
                buyerUsername: buyerUsername,
                productTitle: postData.title,
                isRead: false,
                timestamp: FieldValue.serverTimestamp()
            });

            const purchaseEventRef = db.collection('purchaseEvents').doc();
            t.set(purchaseEventRef, {
                buyerUsername: buyerUsername,
                itemTitle: postData.title,
                timestamp: FieldValue.serverTimestamp()
            });

            if (postData.isInfinite === false) {
                const newStock = postData.stock - 1;
                if (newStock > 0) {
                    t.update(postRef, { stock: newStock });
                } else {
                    t.delete(postRef);
                }
            }

            return { link: postData.link };
        });
        
        return res.status(200).json({ message: 'Purchase successful!', link: result.link });

    } catch (error) {
        console.error("Buy Item Error:", error);
        return res.status(400).json({ error: error.message });
    }
});

app.post('/generate-code', async (req, res) => { const idToken = req.headers.authorization?.split('Bearer ')[1]; const numericAmount = Number(req.body.amount); if (!idToken || !numericAmount || numericAmount <= 0 || !Number.isInteger(numericAmount)) { return res.status(400).json({ error: 'Token or amount is missing or invalid.' }); } try { const decodedToken = await auth.verifyIdToken(idToken); const uid = decodedToken.uid; const userDocRef = db.collection('users').doc(uid); const newCode = await db.runTransaction(async (t) => { const userDoc = await t.get(userDocRef); if (!userDoc.exists) { throw new Error("User profile not found."); } const currentBalance = Number(userDoc.data().balance); if (isNaN(currentBalance)) { throw new Error("Invalid balance data. Please contact an admin."); } if (currentBalance < numericAmount) { throw new Error("Insufficient balance."); } const newBalance = currentBalance - numericAmount; const code = Math.random().toString(36).substring(2, 8).toUpperCase(); t.update(userDocRef, { balance: newBalance }); t.set(db.collection('codes').doc(code), { amount: numericAmount }); return code; }); return res.status(200).json({ message: `Code created successfully!`, code: newCode }); } catch (error) { console.error("Generate Code Error:", error); return res.status(400).json({ error: error.message }); } });
app.post('/redeem-code', async (req, res) => { const idToken = req.headers.authorization?.split('Bearer ')[1]; const { code } = req.body; if (!idToken || !code) return res.status(400).json({ error: 'Token or code is missing.' }); try { const decodedToken = await auth.verifyIdToken(idToken); const uid = decodedToken.uid; const userDocRef = db.collection('users').doc(uid); const codeDocRef = db.collection('codes').doc(code); const redeemedAmount = await db.runTransaction(async (t) => { const codeDoc = await t.get(codeDocRef); if (!codeDoc.exists) throw new Error('Invalid or already used code.'); const amount = codeDoc.data().amount; const userDoc = await t.get(userDocRef); if (!userDoc.exists) throw new Error('User profile not found.'); const newBalance = userDoc.data().balance + amount; t.update(userDocRef, { balance: newBalance }); t.delete(codeDocRef); return amount; }); return res.status(200).json({ message: `Successfully redeemed ${redeemedAmount.toLocaleString()} EB!` }); } catch (error) { console.error("Redeem Error:", error); return res.status(400).json({ error: error.message }); } });

// --- START SERVER ---
const listener = app.listen(process.env.PORT || 3000, () => {
    console.log('✅ EpiBux full-stack server is listening on port ' + listener.address().port);
});
