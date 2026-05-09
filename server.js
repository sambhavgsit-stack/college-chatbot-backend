const express = require("express");
const cors = require("cors");
const Groq = require("groq-sdk");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;
    console.log("Received:", message);

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are a helpful college assistant for students.
                    You help with questions about timetables, notices, placement updates, and college information.
                    VERY IMPORTANT: Always detect the language the user is writing in and reply in EXACTLY that same language.
                    If user writes in English → reply in English.
                    If user writes in Hindi → reply in Hindi.
                    If user writes in Hinglish (mixed Hindi+English) → reply in Hinglish.
                    Never switch languages unless the user switches first.
                    Be friendly, clear and concise.`
        },
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