/**
 * Swappable LLM Analyzer for Meeting Notes AI.
 * Supports:
 * - Google Gemini (default, e.g. gemini-2.5-flash, gemini-1.5-flash) via official REST API
 * - OpenAI / OpenAI-compatible (Groq, OpenRouter, Together, Local Ollama) via chat completions REST API
 *
 * Uses native Node fetch without heavy SDK dependencies.
 */

const DEFAULT_QUESTION_KINDS = ["স্পষ্টীকরণ", "গভীরে", "ঝুঁকি", "অ্যাকশন"];

/**
 * System instruction defining the meeting analyst role and JSON schema.
 */
function buildSystemPrompt(topics, existingQuestions, questionKinds, language = "bn") {
  const allowedKinds = questionKinds?.length ? questionKinds.join(", ") : DEFAULT_QUESTION_KINDS.join(", ");
  const hasTopics = Array.isArray(topics) && topics.length > 0;
  const topicInstruction = hasTopics
    ? `Extract concise, factual notes specifically regarding the tracked topics: [${topics.join(", ")}].`
    : `Extract concise, factual summary notes of the key points, decisions, and facts discussed.`;
  const priorQuestions = existingQuestions?.length ? existingQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n") : "None yet.";

  let languageDirective = "All generated questions, quotes, and meeting notes MUST be written in natural, fluent BENGALI (বাংলা).";
  if (language === "en") {
    languageDirective = "All generated questions, quotes, and meeting notes MUST be written in natural, fluent ENGLISH.";
  } else if (language === "multi") {
    languageDirective = "Write questions and notes in the natural language used by the speaker (Bengali or English as appropriate).";
  }

  return `You are a discreet, senior executive meeting intelligence assistant for a professional listening in real-time.
${languageDirective}

Your goal:
1. Generate up to 3 sharp, high-value questions the user can ask the speaker (e.g. Clarification, Risk, Action item, Deep-dive).
2. ${topicInstruction}

RULES:
- Output MUST be valid JSON ONLY matching this exact schema:
{
  "questions": [
    {
      "kind": "one of: ${allowedKinds}",
      "question": "The question according to the language directive",
      "quote": "Short exact or near-exact phrase from the transcript that triggered this"
    }
  ],
  "notes": [
    "Short, high-signal note according to the language directive"
  ]
}

STRICT CONSTRAINTS:
- Maximum 3 questions total. Return empty array [] if nothing is worth asking.
- Question kinds MUST be exactly one of: ${allowedKinds}
- Ground every question and quote in the provided transcript. Never hallucinate.
- DO NOT repeat or rephrase any previously asked questions:
Previously asked questions:
${priorQuestions}
- ${languageDirective}
- Return PURE JSON with NO markdown code fences, NO introductory text.`;
}

/**
 * Calls Google Gemini REST API.
 */
async function callGemini({ apiKey, model, systemPrompt, userContent }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    system_instruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userContent }],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
    },
  };

  let res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  // Handle temporary 503 demand spikes with a single quick retry
  if (res.status === 503) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  // Handle 404 model migration by falling back to gemini-3.5-flash-lite
  if (res.status === 404 && model !== "gemini-3.5-flash-lite") {
    console.warn(`[LLM/Gemini] Model ${model} returned 404. Falling back to gemini-3.5-flash-lite...`);
    const fallbackEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;
    res = await fetch(fallbackEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errorBody}`);
  }

  const json = await res.json();
  const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text;
  return rawText;
}

/**
 * Calls OpenAI or OpenAI-compatible endpoint (Groq, OpenRouter, Ollama).
 */
async function callOpenAICompatible({ apiKey, model, baseUrl, systemPrompt, userContent }) {
  const url = baseUrl ? `${baseUrl.replace(/\/+$/, "")}/chat/completions` : "https://api.openai.com/v1/chat/completions";

  const payload = {
    model: model || "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`OpenAI-compatible API error (${res.status}): ${errorBody}`);
  }

  const json = await res.json();
  return json.choices?.[0]?.message?.content;
}

/**
 * Parses raw LLM response string into clean JSON safely.
 */
function parseJSONSafely(raw) {
  if (!raw || typeof raw !== "string") {
    return { questions: [], notes: [] };
  }

  try {
    // Direct parse
    return JSON.parse(raw);
  } catch {
    // Attempt extracting between first { and last }
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch { }
    }
  }

  return { questions: [], notes: [] };
}

/**
 * Main analysis function.
 *
 * @param {Object} params
 * @param {string} params.transcriptWindow - Recent 1-2 minutes of meeting transcript
 * @param {string[]} params.topics - Tracked topics from user
 * @param {string[]} params.existingQuestions - Questions already emitted during session
 * @param {string[]} params.questionKinds - Allowed question kinds
 * @returns {Promise<{questions: Array<{kind: string, question: string, quote: string}>, notes: string[]}>}
 */
export async function analyzeTranscript({
  transcriptWindow,
  language = "bn",
  topics = [],
  existingQuestions = [],
  questionKinds = DEFAULT_QUESTION_KINDS,
}) {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || apiKey === "your_llm_api_key_here") {
    console.warn("[LLM] LLM_API_KEY is not set in backend/.env. Skipping analysis.");
    return { questions: [], notes: [] };
  }

  // Cost/latency optimization: skip analysis if text is too short (< 40 characters)
  const trimmed = transcriptWindow?.trim();
  if (!trimmed || trimmed.length < 40) {
    return { questions: [], notes: [] };
  }

  const provider = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
  const model = process.env.LLM_MODEL || (provider === "gemini" ? "gemini-3.5-flash-lite" : "gpt-4o-mini");
  const baseUrl = process.env.LLM_BASE_URL;

  const systemPrompt = buildSystemPrompt(topics, existingQuestions, questionKinds, language);
  const userContent = `Recent Transcript Window:\n"""\n${trimmed}\n"""\n\nGenerate high-signal questions and topic notes according to the instructions.`;

  try {
    let rawOutput;
    if (provider === "gemini") {
      rawOutput = await callGemini({ apiKey, model, systemPrompt, userContent });
    } else {
      rawOutput = await callOpenAICompatible({ apiKey, model, baseUrl, systemPrompt, userContent });
    }

    const parsed = parseJSONSafely(rawOutput);

    // Validate and sanitize questions
    const validQuestions = Array.isArray(parsed.questions)
      ? parsed.questions
        .filter((q) => q && typeof q.question === "string" && q.question.trim().length > 0)
        .slice(0, 3)
        .map((q) => ({
          kind: q.kind && questionKinds.includes(q.kind) ? q.kind : questionKinds[0] || "স্পষ্টীকরণ",
          question: q.question.trim(),
          quote: typeof q.quote === "string" ? q.quote.trim() : "",
        }))
      : [];

    // Validate and sanitize notes
    const validNotes = Array.isArray(parsed.notes)
      ? parsed.notes
        .filter((n) => typeof n === "string" && n.trim().length > 0)
        .map((n) => n.trim())
      : [];

    return {
      questions: validQuestions,
      notes: validNotes,
    };
  } catch (err) {
    console.error(`[LLM Analysis Error] ${err.message}`);
    return { questions: [], notes: [] };
  }
}

/**
 * Fast real-time transcript translator and Hindi/Devanagari script cleaner.
 */
export async function translateOrCleanTranscript({ text, targetLanguage = "bn" }) {
  if (!text || typeof text !== "string") return text;
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  const hasDevanagari = /[\u0900-\u097F]/.test(trimmed);
  const hasBengali = /[\u0980-\u09FF]/.test(trimmed);
  const hasLatin = /[a-zA-Z]/.test(trimmed);

  // If text already matches the expected language and has no unwanted Hindi:
  if (targetLanguage === "bn" && hasBengali && !hasDevanagari && !hasLatin) {
    return trimmed;
  }
  if (targetLanguage === "en" && hasLatin && !hasBengali && !hasDevanagari) {
    return trimmed;
  }
  if (targetLanguage === "multi" && !hasDevanagari) {
    return trimmed;
  }

  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return trimmed;

  const model = process.env.LLM_MODEL || "gemini-3.5-flash-lite";

  let promptTarget = "Bengali (বাংলা)";
  if (targetLanguage === "en") promptTarget = "English";
  else if (targetLanguage === "multi") promptTarget = "the original intended language (Bengali or English, never Hindi/Devanagari)";

  const prompt = `You are a real-time transcript translator and cleaner.
Convert/translate the following speech transcript into natural, accurate ${promptTarget}.
RULES:
1. Output ONLY the translated/cleaned text.
2. Do NOT output any explanations, tags, quotes, or markdown.
3. If it was Bengali speech mistakenly transcribed in Hindi/Devanagari, convert it to pure Bengali.

Text:
"${trimmed}"`;

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 },
      }),
    });

    if (res.ok) {
      const json = await res.json();
      const output = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (output) {
        return output.replace(/^["']|["']$/g, "");
      }
    }
  } catch (err) {
    console.warn("[Translate Error]", err.message);
  }

  return trimmed;
}

