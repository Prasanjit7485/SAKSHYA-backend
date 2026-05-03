const express = require("express");
const OpenAI = require("openai");

const router = express.Router();

function getClient() {
  return new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": process.env.FRONTEND_URL,
      "X-Title": "CCMS Hackathon Project",
    },
    maxRetries: 3,      // ← retry up to 3 times on connection errors
    timeout: 30000,     // ← 30 second timeout (default is 10s, too short)
  });
}

function buildSystemPrompt(context) {
  // Trim context to avoid token overflow on second+ calls
  const safeContext = JSON.stringify(context).slice(0, 6000);
  return `You are SAKSHYA Assistant — an expert legal AI built for the Court Case Monitoring System (CCMS) of the Centre for e-Governance, India.

You have been given the full structured analysis of a court judgment. Answer all follow-up questions using ONLY this data. Be concise, factual and professional. Format lists with bullet points where helpful.

=== JUDGMENT ANALYSIS ===
${safeContext}
========================

Rules:
- Never invent facts not present in the analysis above.
- If the user asks something outside the document, say "This information is not available in the analyzed judgment."
- When referencing deadlines or compliance items, always emphasise urgency if applicable.
- Keep answers short (3–6 sentences max) unless a detailed breakdown is explicitly asked.
- Do NOT use **markdown bold** in your responses. Use plain text only.`;
}

/**
 * Retry wrapper — retries on ECONNRESET / network errors
 */
async function callWithRetry(fn, retries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isNetworkError =
        err.code === "ECONNRESET" ||
        err.message?.includes("terminated") ||
        err.message?.includes("ECONNRESET") ||
        err.cause?.code === "ECONNRESET";

      if (isNetworkError && attempt < retries) {
        console.log(`⚠️ Network error on attempt ${attempt}, retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs * attempt)); // exponential back-off
        continue;
      }
      throw err; // re-throw if not retryable or out of retries
    }
  }
}

/**
 * POST /api/chat
 * Body: { context: <judgment data object>, history: [{role, content}], message: string }
 */
router.post("/", async (req, res) => {
  const { context, history = [], message } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message field is required." });
  }
  if (!context || typeof context !== "object") {
    return res.status(400).json({ error: "context (judgment data) is required." });
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: "OPENROUTER_API_KEY not configured on server." });
  }

  try {
    const client = getClient();

    const messages = [
      { role: "system", content: buildSystemPrompt(context) },
      ...history.slice(-10).map(({ role, content }) => ({ role, content })),
      { role: "user", content: message },
    ];

    const reply = await callWithRetry(async () => {
      const response = await client.chat.completions.create({
        model: "openai/gpt-4o-mini",
        temperature: 0.3,
        max_tokens: 500,
        messages,
      });
      return response.choices[0].message.content;
    });

    return res.json({ success: true, reply });

  } catch (err) {
    console.error("❌ Chat error:", err);

    const isNetworkError =
      err.code === "ECONNRESET" ||
      err.message?.includes("terminated") ||
      err.cause?.code === "ECONNRESET";

    if (isNetworkError) {
      return res.status(503).json({
        error: "Connection to AI service was interrupted. Please try again.",
      });
    }
    if (err.status === 429) {
      return res.json({
        success: true,
        reply: "I'm temporarily unavailable due to rate limits. Please try again in a moment.",
      });
    }
    if (err.status === 401) {
      return res.status(401).json({ error: "Invalid OpenRouter API key." });
    }

    return res.status(500).json({ error: err.message || "Failed to process chat message." });
  }
});

module.exports = router;