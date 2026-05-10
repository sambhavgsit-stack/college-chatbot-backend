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
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const JWT_SECRET = "college-chatbot-secret-key";

let users = [
  {
    id: 1,
    name: "Admin",
    email: "admin@college.com",
    password: bcrypt.hashSync("admin123", 10),
    role: "admin"
  },
  {
    id: 2,
    name: "Faculty",
    email: "faculty@college.com",
    password: bcrypt.hashSync("faculty123", 10),
    role: "faculty"
  }
];

let knowledgeBase = [];
const upload = multer({ dest: "uploads/" });

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

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email);
    if (!user) return res.status(401).json({ error: "Invalid email or password" });
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: "Invalid email or password" });
    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    console.log(`Login: ${user.email} (${user.role})`);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/upload", verifyToken, requireRole("admin", "faculty"), upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const ext = path.extname(file.originalname).toLowerCase();
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

    knowledgeBase.push({
      type: "document",
      name: file.originalname,
      content: text,
      uploadedBy: req.user.name,
      uploadedAt: new Date().toISOString()
    });

    fs.unlinkSync(file.path);
    console.log(`Document uploaded: ${file.originalname} by ${req.user.name}`);
    res.json({ message: `${file.originalname} uploaded successfully!`, totalDocs: knowledgeBase.length });
  } catch (error) {
    console.error("Upload error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/faq", verifyToken, requireRole("admin", "faculty"), async (req, res) => {
  try {
    const { question, answer } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ error: "Both question and answer are required." });
    }
    knowledgeBase.push({
      type: "faq",
      name: "FAQ",
      content: `Question: ${question}\nAnswer: ${answer}`,
      uploadedBy: req.user.name,
      uploadedAt: new Date().toISOString()
    });
    console.log(`FAQ added by ${req.user.name}: ${question}`);
    res.json({ message: "FAQ added successfully!", totalDocs: knowledgeBase.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/knowledge", verifyToken, (req, res) => {
  res.json({
    total: knowledgeBase.length,
    items: knowledgeBase.map(item => ({
      type: item.type,
      name: item.name,
      uploadedBy: item.uploadedBy,
      uploadedAt: item.uploadedAt
    }))
  });
});

app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;
    console.log("Message:", message);

    let context = "";
    if (knowledgeBase.length > 0) {
      context = knowledgeBase.map(item => `[${item.name}]:\n${item.content}`).join("\n\n---\n\n");
    }

    const languageInstruction = `CRITICAL LANGUAGE RULE: You MUST detect the exact language the user wrote in and reply in THAT EXACT language only.
- User wrote in English → reply in English only, zero Hindi words
- User wrote in Hindi → reply in Hindi only
- User wrote in Hinglish → reply in Hinglish
- Never assume language from location, only from what the user actually typed`;

    const systemPrompt = knowledgeBase.length > 0
      ? `You are a helpful college assistant for students.
You have access to the following college documents and FAQs:

${context}

INSTRUCTIONS:
- Answer questions ONLY based on the documents and FAQs above
- Give ONLY the specific information asked — do not add extra details
- If the answer is not in the documents, reply with exactly these two lines:
  "I don't have information about that.\nPlease contact the Student Section for assistance."
- Be concise — answer in 1-2 sentences maximum unless the question requires more detail
${languageInstruction}`
      : `You are a helpful college assistant for students.
For every message, reply with exactly this and nothing else:
"I don't have information about that.\n Please contact the "Student Section" for assistance."
${languageInstruction}`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ],
    });

    res.json({ reply: response.choices[0].message.content });
  } catch (error) {
    console.error("ERROR:", error.message);
    res.status(500).json({ reply: "Error: " + error.message });
  }
});

app.listen(5001, () => {
  console.log("Backend running on http://localhost:5001");
});