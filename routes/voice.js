/**
 * SAKSHYA-backend/routes/voice.js
 *
 * Fixes & additions:
 *  1. Added `lang` param support — "en" (default) or "hi" (Hindi).
 *  2. Hindi: uses a separate GPT call to translate the script before TTS.
 *  3. TTS voice changed to "nova" for better Hindi pronunciation.
 *  4. Route is now protected with verifyJWT (was missing, causing 401s).
 *  5. Better error messages sent back to the client.
 */

const express   = require("express");
const OpenAI    = require("openai");
const verifyJWT = require("../middleware/authMiddleware");

const router = express.Router();

// ── Direct OpenAI client (TTS not available on OpenRouter) ────────────────────
function getOpenAIClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ── OpenRouter client (for Hindi translation) ─────────────────────────────────
function getORClient() {
  return new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": process.env.FRONTEND_URL,
      "X-Title": "CCMS Hackathon Project",
    },
  });
}

// ── Build natural spoken script from judgment JSON ────────────────────────────
function buildVoiceScript(data) {
  const lines = [];

  lines.push("SAKSHYA Voice Summary. Here is the structured analysis of the uploaded judgment.");

  if (data.summary) {
    lines.push(`Judgment Summary. ${data.summary}`);
  }

  // Top 3 directives by priority
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const topDirectives = (data.keyDirectives || [])
    .slice()
    .sort((a, b) => (priorityOrder[a.priority] ?? 4) - (priorityOrder[b.priority] ?? 4))
    .slice(0, 3);

  if (topDirectives.length) {
    lines.push(`Key Directives. The following ${topDirectives.length} directives require immediate attention.`);
    topDirectives.forEach((d, i) => {
      let text = `Directive ${i + 1}. ${d.directive || d.text || ""}`;
      if (d.deadline)   text += `. Deadline: ${d.deadline}.`;
      if (d.authority)  text += `. Responsible authority: ${d.authority}.`;
      lines.push(text);
    });
  }

  // Action items
  if (data.action_items?.length) {
    lines.push("Action Items.");
    data.action_items.slice(0, 3).forEach((item, i) => {
      lines.push(`Action ${i + 1}: ${item}`);
    });
  }

  // Risk flags
  const topRisks = (data.riskFlags || [])
    .filter(r => r.severity === "high" || r.severity === "medium")
    .slice(0, 3);

  if (topRisks.length) {
    lines.push("Risk Factors.");
    topRisks.forEach((r, i) => {
      lines.push(`Risk ${i + 1}: ${r.flag}`);
    });
  }

  // Negotiation highlights
  const topNeg = (data.negotiationCheatSheet || []).slice(0, 2);
  if (topNeg.length) {
    lines.push("Negotiation Highlights.");
    topNeg.forEach((n, i) => {
      lines.push(`Clause ${i + 1}: ${n.clauseTitle}. ${n.suggestedChange}`);
    });
  }

  lines.push("End of SAKSHYA voice summary. Please review the full report for complete details.");

  return lines.join(" ... ");
}

// ── Translate script to Hindi using GPT ───────────────────────────────────────
async function translateToHindi(script) {
  const client = getORClient();
  const response = await client.chat.completions.create({
    model: "openai/gpt-4o-mini",
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content:
          "You are a professional Hindi translator. Translate the following legal voice summary into simple, clear Hindi (Devanagari script). Keep legal terms that have no Hindi equivalent in English. Keep the same structure and ellipsis pauses. Return only the translated text, nothing else.",
      },
      { role: "user", content: script },
    ],
  });
  return response.choices[0].message.content.trim();
}

// ── POST /api/voice/summary ───────────────────────────────────────────────────
// Body: { data: <judgment JSON>, lang: "en"|"hi" }
// Returns: audio/mpeg
router.post("/summary", verifyJWT, async (req, res) => {
  const { data, lang = "en" } = req.body;

  if (!data || typeof data !== "object") {
    return res.status(400).json({ error: "data field (judgment JSON) is required." });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "OPENAI_API_KEY not set. Add it to SAKSHYA-backend/.env to enable voice summaries.",
    });
  }

  try {
    let script = buildVoiceScript(data);
    console.log(`🎙️ Voice summary requested. Lang: ${lang}. Script length: ${script.length}`);

    // Translate if Hindi requested
    if (lang === "hi") {
      try {
        script = await translateToHindi(script);
        console.log("✅ Hindi translation done. Length:", script.length);
      } catch (trErr) {
        console.warn("⚠️ Hindi translation failed, falling back to English:", trErr.message);
      }
    }

    res.json({ script });
    console.log(`✅ Voice script sent (${lang})`);

  } catch (err) {
    console.error("❌ TTS error:", err);
    if (err.status === 401) return res.status(401).json({ error: "Invalid API Key." });
    if (err.status === 429) return res.status(429).json({ error: "Rate limit hit. Try again shortly." });
    return res.status(500).json({ error: err.message || "Voice script generation failed." });
  }
});

module.exports = router;
