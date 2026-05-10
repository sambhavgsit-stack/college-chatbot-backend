const express = require("express");
const cors = require("cors");
const Groq = require("groq-sdk");
const multer = require("multer");
const mammoth = require("mammoth");
const PDFParser = require("pdf2json");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let knowledgeBase = [];

const upload = multer({ dest: "uploads/" });

app.post("/upload", upload.single("file"), async (req, res) => {
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
      uploadedAt: new Date().toISOString()
    });

    fs.unlinkSync(file.path);
    console.log(`Document uploaded: ${file.originalname}`);
    res.json({ message: `${file.originalname} uploaded successfully!`, totalDocs: knowledgeBase.length });

  } catch (error) {
    console.error("Upload error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/faq", async (req, res) => {
  try {
    const { question, answer } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ error: "Both question and answer are required." });
    }
    knowledgeBase.push({
      type: "faq",
      name: "FAQ",
      content: `Question: ${question}\nAnswer: ${answer}`,
      uploadedAt: new Date().toISOString()
    });
    console.log(`FAQ added: ${question}`);
    res.json({ message: "FAQ added successfully!", totalDocs: knowledgeBase.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/knowledge", (req, res) => {
  res.json({
    total: knowledgeBase.length,
    items: knowledgeBase.map(item => ({
      type: item.type,
      name: item.name,
      uploadedAt: item.uploadedAt
    }))
  });
});

app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;
    console.log("Received:", message);

    let context = "";
    if (knowledgeBase.length > 0) {
      context = knowledgeBase.map(item => `[${item.name}]:\n${item.content}`).join("\n\n---\n\n");
    }

    const systemPrompt = knowledgeBase.length > 0
      ? `You are a helpful college assistant for students.
         You have access to the following college documents and FAQs:
         
         ${context}
         
         INSTRUCTIONS:
         - Answer questions ONLY based on the documents and FAQs above
         - Give ONLY the specific information asked — do not add extra details the user did not ask for
         - If user asks for date of birth, give ONLY the date of birth, nothing else
         - If the answer is not in the documents, say "I don't have information about that. Please contact the Student Section for assistance."
         - Always respond in the same language the user writes in — Hindi, English, or Hinglish
         - Be concise — answer in 1-2 sentences maximum unless the question requires more detail`
      : `You are a helpful college assistant for students.
         No documents have been uploaded yet. Tell the user that the admin needs to upload documents first.
         Always respond in the same language the user writes in — Hindi, English, or Hinglish.`;

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