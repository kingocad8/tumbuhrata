// TumbuhRata — /api/chat (bilingual v2.0, ID + EN)
// Chatbot "Tanya"/"Ask AI" untuk orang tua toddler 1-3 tahun. Pola sama seperti
// LatihTOEFL /api/grade: key GEMINI_API_KEY dibaca dari env Vercel,
// TANPA key fungsi menjawab 503 (fail-closed) dan halaman memakai FAQ lokal.
// Key gratis yang sama dengan Kamus Oleokimia. Tanpa fallback Groq.
// Rantai model: gemini-3.5-flash-lite -> gemini-3.6-flash -> gemini-flash-lite-latest.
// Endpoint OpenAI-compatible dulu, lalu native generateContent.
// Bahasa dipilih dari body.lang ('id' | 'en', default 'id') — prompt sistem,
// konteks usia, dan pesan error ikut bahasa yang dipilih.

const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-flash-lite-latest'];

const SYSTEM_PROMPTS = {
  id: [
    'Kamu asisten parenting TumbuhRata untuk orang tua anak usia 1-3 tahun.',
    'Jawab singkat, to-the-point, bahasa Indonesia awam yang mudah dipahami orang tua.',
    'Dasar jawaban: panduan resmi IDAI, Kemenkes (SDIDTK/KPSP), CDC, WHO. Sebut sumbernya bila relevan.',
    'Kamu BUKAN dokter dan BUKAN pemberi diagnosis. Jangan mendiagnosis anak, jangan memberi dosis obat atau terapi.',
    'Bila ada tanda bahaya (mis. kejang, sesak, dehidrasi, kehilangan kemampuan yang sudah dikuasai, tidak responsif): arahkan segera ke dokter anak / IGD / Puskesmas, jangan menenangkan dengan "tidak apa-apa".',
    'Bila pertanyaan di luar tumbuh kembang, pendidikan, atau parenting anak 1-3 tahun: tolak sopan dan arahkan ke topik yang bisa dijawab.',
    'Jangan minta nama lengkap atau tanggal lahir anak. Maksimal sekitar 150 kata per jawaban.',
  ].join(' '),
  en: [
    'You are the TumbuhRata parenting assistant for parents of children ages 1-3 years.',
    'Answer briefly, to the point, in plain everyday English that parents can easily understand.',
    'Base your answers on official guidance: CDC (Learn the Signs. Act Early. milestones), WHO, AAP. Name the source when relevant.',
    'You are NOT a doctor and do NOT give diagnoses. Never diagnose a child, never give medicine doses or therapy.',
    'If there are red flags (for example seizures, trouble breathing, dehydration, loss of skills the child once had, unresponsiveness): direct the parent to a pediatrician / emergency care right away — do not reassure with "it is fine".',
    'If the question is outside toddler development, learning, or parenting for ages 1-3: politely decline and point to topics you can answer.',
    "Do not ask for the child's full name or date of birth. Maximum about 150 words per answer.",
  ].join(' '),
};

const ERRORS = {
  id: {
    method: 'Method tidak diizinkan',
    badJson: 'Body bukan JSON yang valid',
    badMessages: 'Pesan tidak valid',
    noKey: 'AI belum aktif — API key belum dipasang di Vercel project ini',
    failed: 'AI gagal menjawab, coba lagi sebentar',
  },
  en: {
    method: 'Method not allowed',
    badJson: 'Body is not valid JSON',
    badMessages: 'Invalid messages',
    noKey: 'AI is not active — API key has not been added to this Vercel project yet',
    failed: 'AI failed to answer, please try again in a moment',
  },
};

function json(res, status, obj) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function validMessages(body) {
  if (!body || typeof body !== 'object') return false;
  const m = body.messages;
  if (!Array.isArray(m) || m.length === 0 || m.length > 20) return false;
  for (const x of m) {
    if (!x || typeof x !== 'object') return false;
    if (x.role !== 'user' && x.role !== 'assistant') return false;
    if (typeof x.content !== 'string' || x.content.trim().length === 0 || x.content.length > 2000) return false;
  }
  if (m[m.length - 1].role !== 'user') return false;
  return true;
}

async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function callOpenAICompatible(key, systemPrompt, messages) {
  for (const model of MODELS) {
    try {
      const r = await fetchWithTimeout(
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: systemPrompt }, ...messages],
            max_tokens: 600,
            temperature: 0.7,
          }),
        },
        20000
      );
      if (!r.ok) continue;
      const data = await r.json();
      const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (typeof text === 'string' && text.trim()) return text.trim();
    } catch (e) {
      // coba model / jalur berikutnya
    }
  }
  return null;
}

async function callNative(key, systemPrompt, messages) {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  for (const model of MODELS) {
    try {
      const r = await fetchWithTimeout(
        'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: { maxOutputTokens: 600, temperature: 0.7 },
          }),
        },
        20000
      );
      if (!r.ok) continue;
      const data = await r.json();
      const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      const text = Array.isArray(parts) ? parts.map((p) => p.text || '').join('').trim() : '';
      if (text) return text;
    } catch (e) {
      // coba model berikutnya
    }
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method tidak diizinkan' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return json(res, 400, { error: 'Body bukan JSON yang valid' });
    }
  }
  const lang = body && body.lang === 'en' ? 'en' : 'id';
  const err = ERRORS[lang];
  const systemPrompt = SYSTEM_PROMPTS[lang];
  if (!validMessages(body)) {
    return json(res, 400, { error: err.badMessages });
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return json(res, 503, { error: err.noKey });
  }
  const messages = body.messages.map((m) => ({ role: m.role, content: m.content }));
  const ageMonths = Number(body.ageMonths);
  if (Number.isFinite(ageMonths) && ageMonths > 0) {
    const ctx =
      lang === 'en'
        ? 'Context: the child is ' + Math.round(ageMonths) + ' months old.'
        : 'Konteks: anak berusia ' + Math.round(ageMonths) + ' bulan.';
    messages.unshift({ role: 'user', content: ctx });
  }
  let reply = await callOpenAICompatible(key, systemPrompt, messages);
  if (!reply) reply = await callNative(key, systemPrompt, messages);
  if (!reply) {
    return json(res, 502, { error: err.failed });
  }
  return json(res, 200, { reply });
};
