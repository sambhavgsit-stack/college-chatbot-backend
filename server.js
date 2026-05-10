const express = require("express");
const cors = require("cors");
const Groq = require("groq-sdk");
const multer = require("multer");
const mammoth = require("mammoth");
const PDFParser = require("pdf2json");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const JWT_SECRET = "college-chatbot-secret-key";

// ===== CONNECT TO MONGODB =====
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("Connected to MongoDB!"))
  .catch(err => console.error("MongoDB connection error:", err));

// ===== SCHEMAS =====
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, enum: ["admin", "faculty"], default: "faculty" },
  createdAt: { type: Date, default: Date.now }
});

const knowledgeSchema = new mongoose.Schema({
  type: { type: String, enum: ["document", "faq"] },
  name: String,
  content: String,
  uploadedBy: String,
  downloadable: { type: Boolean, default: false },
  filePath: String,
  uploadedAt: { type: Date, default: Date.now }
});

const questionSchema = new mongoose.Schema({
  question: String,
  answered: Boolean,
  askedAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);
const Knowledge = mongoose.model("Knowledge", knowledgeSchema);
const Question = mongoose.model("Question", questionSchema);

// ===== SEED DEFAULT USERS =====
async function seedUsers() {
  const count = await User.countDocuments();
  if (count === 0) {
    await User.create([
      {
        name: "Admin",
        email: "admin@college.com",
        password: bcrypt.hashSync("admin123", 10),
        role: "admin"
      },
      {
        name: "Faculty",
        email: "faculty@college.com",
        password: bcrypt.hashSync("faculty123", 10),
        role: "faculty"
      }
    ]);
    console.log("Default users created!");
  }
}

// ===== MIDDLEWARE =====
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + file.originalname;
    cb(null, unique);
  }
});
const upload = multer({ storage });

function verifyToken(req, res, next) {
  const token = req.headers["authorization"];
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Access denied" });
    }
    next();
  };
}

// ===== LOGIN =====
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: "Invalid email or password" });
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: "Invalid email or password" });
    const token = jwt.sign(
      { id: user._id, name: user.name, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    console.log(`Login: ${user.email} (${user.role})`);
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== UPLOAD =====
app.post("/upload", verifyToken, requireRole("admin", "faculty"), upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const ext = path.extname(file.originalname).toLowerCase();
    const downloadable = req.body.downloadable === "true";
    let text = "";

    if (ext === ".pdf") {
      text = await new Promise((resolve, reject) => {
        const pdfParser = new PDFParser();
        pdfParser.on("pdfParser_dataReady", (data) => {
          const extracted = data.Pages.map(page =>
            page.Texts.map(t => decodeURIComponent(t.R[0].T)).join(" ")
          ).join("\n");
          resolve(extracted);
        });
        pdfParser.on("pdfParser_dataError", reject);
        pdfParser.loadPDF(file.path);
      });
    } else if (ext === ".docx") {
      const buffer = fs.readFileSync(file.path);
      const data = await mammoth.extractRawText({ buffer });
      text = data.value;
    } else if (ext === ".txt") {
      text = fs.readFileSync(file.path, "utf8");
    } else {
      return res.status(400).json({ error: "Unsupported file type. Use PDF, DOCX, or TXT." });
    }

    const doc = await Knowledge.create({
      type: "document",
      name: file.originalname,
      content: text,
      uploadedBy: req.user.name,
      downloadable,
      filePath: downloadable ? file.path : null
    });

    if (!downloadable) fs.unlinkSync(file.path);

    console.log(`Document uploaded: ${file.originalname} by ${req.user.name}`);
    res.json({ message: `${file.originalname} uploaded successfully!` });
  } catch (error) {
    console.error("Upload error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== FAQ =====
app.post("/faq", verifyToken, requireRole("admin", "faculty"), async (req, res) => {
  try {
    const { question, answer } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ error: "Both question and answer are required." });
    }
    await Knowledge.create({
      type: "faq",
      name: "FAQ",
      content: `Question: ${question}\nAnswer: ${answer}`,
      uploadedBy: req.user.name,
      downloadable: false
    });
    console.log(`FAQ added by ${req.user.name}: ${question}`);
    res.json({ message: "FAQ added successfully!" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== KNOWLEDGE BASE =====
app.get("/knowledge", verifyToken, async (req, res) => {
  try {
    const items = await Knowledge.find().sort({ uploadedAt: -1 });
    res.json({
      total: items.length,
      items: items.map(item => ({
        id: item._id,
        type: item.type,
        name: item.name,
        uploadedBy: item.uploadedBy,
        uploadedAt: item.uploadedAt,
        downloadable: item.downloadable
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== DOWNLOAD =====
app.get("/download/:id", async (req, res) => {
  try {
    const item = await Knowledge.findById(req.params.id);
    if (!item) return res.status(404).json({ error: "File not found" });
    if (!item.downloadable) return res.status(403).json({ error: "This file is not available for download" });
    if (!item.filePath || !fs.existsSync(item.filePath)) return res.status(404).json({ error: "File no longer exists on server" });
    res.download(item.filePath, item.name);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== ANALYTICS =====
app.get("/analytics", verifyToken, requireRole("admin", "faculty"), async (req, res) => {
  try {
    const greetings = ["hi", "hey", "hello", "what's up", "whats up", "hii", "helo", "sup", "yo", "namaste", "ok", "okay", "thanks", "thank you", "bye", "test"];
    const allQuestions = await Question.find().sort({ askedAt: -1 });

    const frequency = {};
    allQuestions.forEach(q => {
      const key = q.question.toLowerCase().trim();
      if (greetings.includes(key)) return;
      if (key.length < 10) return;
      if (!frequency[key]) {
        frequency[key] = { question: q.question, count: 0, lastAsked: q.askedAt };
      }
      frequency[key].count++;
      frequency[key].lastAsked = q.askedAt;
    });

    const sorted = Object.values(frequency)
      .filter(q => q.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    res.json({
      totalQuestions: allQuestions.length,
      uniqueQuestions: sorted.length,
      topQuestions: sorted
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== CHAT =====
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;
    console.log("Message:", message);

    const allKnowledge = await Knowledge.find();

    const greetings = ["hi", "hey", "hello", "what's up", "whats up", "hii", "helo", "sup", "yo", "namaste", "ok", "okay", "thanks", "thank you", "bye", "test"];
const cleanMessage = message.toLowerCase().trim();
const shouldLog = cleanMessage.length >= 10 && !greetings.includes(cleanMessage);

  if (shouldLog) {
    await Question.create({
    question: message,
    answered: allKnowledge.length > 0
  });
}

    let context = "";
    if (allKnowledge.length > 0) {
      context = allKnowledge.map(item => `[${item.name}]:\n${item.content}`).join("\n\n---\n\n");
    }

    const languageInstruction = `CRITICAL LANGUAGE RULE: You MUST detect the exact language the user wrote in and reply in THAT EXACT language only.
- User wrote in English → reply in English only, zero Hindi words
- User wrote in Hindi → reply in Hindi only
- User wrote in Hinglish → reply in Hinglish
- Never assume language from location, only from what the user actually typed`;

    const systemPrompt = allKnowledge.length > 0
      ? `You are a helpful college assistant for students.
You have access to the following college documents and FAQs:

${context}

INSTRUCTIONS:
- Answer questions ONLY based on the documents and FAQs above
- Give ONLY the specific information asked — do not add extra details
- If the answer is not in the documents, reply with exactly these two lines:
  "I don't have information about that.\nPlease contact the Student Section for assistance."
- Be concise — answer in 1-2 sentences maximum unless the question requires more detail
- Do NOT mention document names or suggest downloading in your reply — the system handles that separately
${languageInstruction}`
      : `You are a helpful college assistant for students.
For every message, reply with exactly this and nothing else:
"I don't have information about that.\nPlease contact the Student Section for assistance."
${languageInstruction}`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ],
    });

    const reply = response.choices[0].message.content;

    const words = message.toLowerCase().split(" ").filter(w => w.length > 4);
    const relevantDocs = allKnowledge.filter(item => {
      if (!item.downloadable || item.type !== "document") return false;
      return words.some(word =>
        item.content.toLowerCase().includes(word) ||
        item.name.toLowerCase().includes(word)
      );
    });

    res.json({
      reply,
      suggestedDocs: relevantDocs.map(doc => ({
        id: doc._id,
        name: doc.name
      }))
    });

  } catch (error) {
    console.error("ERROR:", error.message);
    res.status(500).json({ reply: "Error: " + error.message });
  }
});

// ===== START SERVER =====
mongoose.connection.once("open", async () => {
  await seedUsers();
  app.listen(5001, () => {
    console.log("Backend running on http://localhost:5001");
  });
});