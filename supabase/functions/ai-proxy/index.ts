// ============================================================================
// KONKOOR YAR — AI PROXY EDGE FUNCTION
// Deno Edge Function — Supabase
// 
// Purpose: پروکسی امن به OpenRouter
// کلید OpenRouter فقط در Secrets این تابع قرار می‌گیرد
// 
// Deploy:
//   supabase functions deploy ai-proxy
//
// Secrets (قبل از deploy):
//   supabase secrets set OPENROUTER_API_KEY=sk-or-v1-xxxxx
//   supabase secrets set OPENROUTER_MODEL=meta-llama/llama-3.1-8b-instruct:free
//   (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY خودکار در دسترسند)
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ============================================================================
// تنظیمات
// ============================================================================

const DAILY_LIMIT = 20;
const MAX_INPUT_CHARS = 6000;
const MAX_OUTPUT_TOKENS = 1400;
const REQUEST_TIMEOUT_MS = 45000;

// محدودسازی CORS — بعد از تست، دامنه GitHub Pages خودت را بگذار
const ALLOWED_ORIGINS = [
  "*",
  // "https://<username>.github.io",
  // "http://localhost:5173",
  // "http://127.0.0.1:5500",
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGINS.join(", "),
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
};

// ============================================================================
// متغیرهای محیطی
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const OPENROUTER_MODEL =
  Deno.env.get("OPENROUTER_MODEL") || "meta-llama/llama-3.1-8b-instruct:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// ============================================================================
// System prompt ثابت (سمت سرور — قابل تغییر توسط کاربر نیست)
// ============================================================================

const SYSTEM_PROMPT = `تو یک دستیار فارسی زبان و متخصص کنکور ایران (گروه تجربی) هستی.

قواعد قطعی:
1. فقط فارسی جواب بده.
2. کوتاه، عملی، بدون شعار و تعارف.
3. هرگز آمار، رتبه، تاریخ، نمره یا ضریب کنکور از خودت نساز. اگر داده نداری، صریح بگو «داده کافی نیست».
4. اگر ورودی متن است، فقط از همان متن استفاده کن. اگر نکته‌ای در متن نبود، صریح بگو «در متن نیست».
5. خروجی همیشه JSON معتبر باشد. بدون بلوک کد مارک‌داون، بدون توضیح اضافه، فقط JSON.
6. از تکرار سؤال کاربر در پاسخ پرهیز کن.
7. طول پاسخ را کوتاه نگه دار. هدف: حداکثر ۸۰۰ کلمه.`;

// ============================================================================
// Schema validation برای هر feature
// ============================================================================

interface MistakeAnalysis {
  categories: string[];
  patterns: string[];
  actions: string[];
  honest: string;
}

interface SummarySection {
  heading: string;
  bullets: string[];
}

interface SummaryResult {
  title: string;
  sections: SummarySection[];
  not_in_text: string[];
}

interface QuizQuestion {
  stem: string;
  options: string[];
  correct_index: number;
  explanation: string;
  needs_review: boolean;
}

interface QuizResult {
  questions: QuizQuestion[];
}

// ============================================================================
// Prompt Builder
// ============================================================================

function limit(s: string, n: number): string {
  return (s || "").slice(0, n);
}

function buildUserPrompt(feature: string, payload: any): string {
  if (feature === "mistake-analysis") {
    const items = Array.isArray(payload?.items)
      ? payload.items.slice(0, 15)
      : [];

    const compact = items.map((it: any, i: number) => ({
      n: i + 1,
      subject: limit(String(it?.subject || ""), 40),
      cause: limit(String(it?.cause || ""), 20),
      question: limit(String(it?.question || ""), 400),
    }));

    return `این ${compact.length} مورد از دفترچه اشتباه من است.
تحلیل کن: چه دسته‌هایی از خطا تکرار می‌شوند؟ چه الگوهای پنهانی وجود دارد؟ سه توصیه عملی بده.

اسکیمای خروجی (فقط JSON):
{
  "categories": ["دسته ۱", "دسته ۲"],
  "patterns": ["الگو ۱", "الگو ۲"],
  "actions": ["توصیه ۱", "توصیه ۲", "توصیه ۳"],
  "honest": "یک جمله صادقانه درباره محدودیت این تحلیل"
}

داده:
${JSON.stringify(compact)}`;
  }

  if (feature === "summary") {
    const text = limit(String(payload?.text || ""), MAX_INPUT_CHARS);
    const topic = limit(String(payload?.topic || ""), 100);

    return `موضوع: ${topic}

فقط از متن زیر خلاصه بساز. چیزهایی که در متن نیست را در not_in_text بگذار.
هر بخش را با یک تیتر کوتاه مشخص کن و ۳ تا ۵ بولت بنویس.

اسکیمای خروجی (فقط JSON):
{
  "title": "عنوان خلاصه",
  "sections": [
    {"heading": "تیتر ۱", "bullets": ["بولت ۱", "بولت ۲"]},
    {"heading": "تیتر ۲", "bullets": ["بولت ۱", "بولت ۲"]}
  ],
  "not_in_text": ["چیزی که نبود"]
}

متن:
${text}`;
  }

  if (feature === "quiz-from-text") {
    const text = limit(String(payload?.text || ""), MAX_INPUT_CHARS);
    const topic = limit(String(payload?.topic || ""), 100);
    const count = Math.min(Math.max(parseInt(payload?.count) || 5, 1), 10);

    return `موضوع: ${topic}
تعداد سؤال: ${count}

از متن زیر ${count} سؤال چهارگزینه‌ای بساز. اگر برای سؤالی مطمئن نیستی، needs_review را true بگذار.

اسکیمای خروجی (فقط JSON):
{
  "questions": [
    {
      "stem": "صورت سؤال",
      "options": ["گزینه ۱", "گزینه ۲", "گزینه ۳", "گزینه ۴"],
      "correct_index": 0,
      "explanation": "توضیح کوتاه",
      "needs_review": false
    }
  ]
}

متن:
${text}`;
  }

  throw new Error("feature ناشناخته: " + feature);
}

// ============================================================================
// JSON Extractor (مقاوم به markdown)
// ============================================================================

function extractJSON(text: string): any {
  if (!text || !text.trim()) throw new Error("پاسخ خالی از مدل");

  let t = String(text).trim();

  // حذف ```json ... ```
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  // پیدا کردن اولین { و آخرین }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error("JSON در پاسخ یافت نشد");
  }

  const jsonStr = t.slice(start, end + 1);
  return JSON.parse(jsonStr);
}

// ============================================================================
// Shape Validation — اطمینان از ساختار درست
// ============================================================================

function validateShape(feature: string, obj: any): any {
  if (!obj || typeof obj !== "object") {
    throw new Error("ساختار پاسخ نامعتبر است");
  }

  if (feature === "mistake-analysis") {
    const result: MistakeAnalysis = {
      categories: Array.isArray(obj.categories)
        ? obj.categories.slice(0, 8).map((x: any) => String(x).slice(0, 200))
        : [],
      patterns: Array.isArray(obj.patterns)
        ? obj.patterns.slice(0, 8).map((x: any) => String(x).slice(0, 300))
        : [],
      actions: Array.isArray(obj.actions)
        ? obj.actions.slice(0, 5).map((x: any) => String(x).slice(0, 300))
        : [],
      honest: String(obj.honest || "داده محدود است؛ این تحلیل قطعی نیست.").slice(0, 300),
    };

    if (result.actions.length === 0) {
      result.actions = ["داده کافی برای توصیه دقیق نیست."];
    }

    return result;
  }

  if (feature === "summary") {
    const sections = Array.isArray(obj.sections)
      ? obj.sections.slice(0, 12).map((s: any) => ({
          heading: String(s?.heading || "").slice(0, 120),
          bullets: Array.isArray(s?.bullets)
            ? s.bullets.slice(0, 8).map((b: any) => String(b).slice(0, 400))
            : [],
        }))
      : [];

    return {
      title: String(obj.title || "خلاصه").slice(0, 140),
      sections,
      not_in_text: Array.isArray(obj.not_in_text)
        ? obj.not_in_text.slice(0, 8).map((x: any) => String(x).slice(0, 200))
        : [],
    } as SummaryResult;
  }

  if (feature === "quiz-from-text") {
    const questions = Array.isArray(obj.questions)
      ? obj.questions.slice(0, 12).map((q: any): QuizQuestion => {
          const opts = Array.isArray(q?.options)
            ? q.options.slice(0, 4).map((x: any) => String(x).slice(0, 300))
            : [];
          while (opts.length < 4) opts.push("—");

          const ci = Math.min(
            Math.max(parseInt(q?.correct_index) || 0, 0),
            3
          );

          return {
            stem: String(q?.stem || "").slice(0, 500),
            options: opts,
            correct_index: ci,
            explanation: String(q?.explanation || "").slice(0, 400),
            needs_review: !!q?.needs_review,
          };
        })
      : [];

    return { questions } as QuizResult;
  }

  throw new Error("feature ناشناخته در validation: " + feature);
}

// ============================================================================
// Hash helper (برای cache key)
// ============================================================================

async function sha256Short(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

// ============================================================================
// Response helpers
// ============================================================================

function jsonResponse(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

async function getRemaining(admin: any, userId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await admin
    .from("ai_usage")
    .select("count")
    .eq("user_id", userId)
    .eq("day", today)
    .maybeSingle();

  const used = data?.count ?? 0;
  return Math.max(0, DAILY_LIMIT - used);
}

// ============================================================================
// OpenRouter call with timeout
// ============================================================================

async function callOpenRouter(
  userPrompt: string,
  signal: AbortSignal
): Promise<string> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    signal,
    headers: {
      Authorization: "Bearer " + OPENROUTER_API_KEY,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://konkoor-yar.app",
      "X-Title": "KonkoorYar",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.4,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter ${res.status}: ${errText.slice(0, 250)}`
    );
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";

  if (!text.trim()) {
    const finishReason = data?.choices?.[0]?.finish_reason;
    if (finishReason === "content_filter") {
      throw new Error("پاسخ توسط فیلتر محتوای OpenRouter مسدود شد");
    }
    if (finishReason === "length") {
      throw new Error("پاسخ ناقص (محدودیت توکن)");
    }
    throw new Error("پاسخ خالی از OpenRouter");
  }

  return text;
}

// ============================================================================
// Main Handler
// ============================================================================

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  try {
    // ======================================================================
    // 1. بررسی authorization header
    // ======================================================================
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return jsonResponse({ error: "unauthorized", message: "توکن ارسال نشده" }, 401);
    }

    // ======================================================================
    // 2. بررسی JWT کاربر با anon key
    // ======================================================================
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();

    if (userErr || !userData?.user) {
      return jsonResponse(
        { error: "unauthorized", message: "نشست نامعتبر یا منقضی" },
        401
      );
    }

    const user = userData.user;

    // ======================================================================
    // 3. بررسی ایمیل مجاز (whitelist اضافه)
    // ======================================================================
    const { data: allowed } = await userClient
      .from("allowed_users")
      .select("email")
      .eq("email", user.email?.toLowerCase())
      .maybeSingle();

    if (!allowed) {
      return jsonResponse(
        { error: "forbidden", message: "این ایمیل مجاز نیست" },
        403
      );
    }

    // ======================================================================
    // 4. پارس کردن body
    // ======================================================================
    let body: any;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "invalid json" }, 400);
    }

    const feature = String(body?.feature || "");
    const payload = body?.payload || {};

    const VALID_FEATURES = ["mistake-analysis", "summary", "quiz-from-text"];
    if (!VALID_FEATURES.includes(feature)) {
      return jsonResponse(
        { error: "feature unknown", message: "قابلیت ناشناخته: " + feature },
        400
      );
    }

    // ======================================================================
    // 5. اعتبارسنجی ورودی
    // ======================================================================
    const textLength = String(payload?.text || "").length;
    if (textLength > MAX_INPUT_CHARS + 500) {
      return jsonResponse(
        { error: "input_too_long", message: "متن ورودی خیلی طولانی است" },
        400
      );
    }

    // ======================================================================
    // 6. Cache lookup
    // ======================================================================
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const cacheKey = await sha256Short(feature + "::" + JSON.stringify(payload));

    const { data: cached } = await admin
      .from("ai_cache")
      .select("payload")
      .eq("user_id", user.id)
      .eq("cache_key", cacheKey)
      .maybeSingle();

    if (cached?.payload) {
      const remaining = await getRemaining(admin, user.id);
      return jsonResponse({
        ok: true,
        cached: true,
        data: cached.payload,
        remaining,
      });
    }

    // ======================================================================
    // 7. بررسی سهم روزانه
    // ======================================================================
    const today = new Date().toISOString().slice(0, 10);

    const { data: usage } = await admin
      .from("ai_usage")
      .select("count")
      .eq("user_id", user.id)
      .eq("day", today)
      .maybeSingle();

    const used = usage?.count ?? 0;

    if (used >= DAILY_LIMIT) {
      return jsonResponse(
        {
          ok: false,
          error: "quota_exceeded",
          remaining: 0,
          message: "سهم امروز تمام شد. فردا دوباره امتحان کن.",
        },
        429
      );
    }

    // ======================================================================
    // 8. ساخت prompt
    // ======================================================================
    let userPrompt: string;
    try {
      userPrompt = buildUserPrompt(feature, payload);
    } catch (err) {
      return jsonResponse(
        { error: "bad_request", message: (err as Error).message },
        400
      );
    }

    // ======================================================================
    // 9. فراخوانی OpenRouter با timeout
    // ======================================================================
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let aiText: string;
    try {
      aiText = await callOpenRouter(userPrompt, controller.signal);
    } catch (err) {
      // حتی خطا هم سهم را مصرف می‌کند (طبق محدودیت OpenRouter)
      await admin.from("ai_usage").upsert(
        { user_id: user.id, day: today, count: used + 1 },
        { onConflict: "user_id,day" }
      );

      const msg =
        (err as Error).name === "AbortError"
          ? "زمان پاسخ‌دهی OpenRouter تمام شد"
          : (err as Error).message;

      return jsonResponse(
        {
          ok: false,
          error: "upstream_error",
          remaining: DAILY_LIMIT - (used + 1),
          message: "خطای سرویس هوش مصنوعی: " + msg,
        },
        502
      );
    } finally {
      clearTimeout(timeoutId);
    }

    // ======================================================================
    // 10. به‌روزرسانی شمارنده مصرف
    // ======================================================================
    await admin.from("ai_usage").upsert(
      { user_id: user.id, day: today, count: used + 1 },
      { onConflict: "user_id,day" }
    );

    const newRemaining = DAILY_LIMIT - (used + 1);

    // ======================================================================
    // 11. پارس و اعتبارسنجی JSON
    // ======================================================================
    let parsed: any;
    try {
      parsed = extractJSON(aiText);
    } catch (err) {
      return jsonResponse(
        {
          ok: false,
          error: "bad_json",
          remaining: newRemaining,
          message: "پاسخ مدل قابل تجزیه نبود: " + (err as Error).message,
        },
        502
      );
    }

    let validated: any;
    try {
      validated = validateShape(feature, parsed);
    } catch (err) {
      return jsonResponse(
        {
          ok: false,
          error: "bad_shape",
          remaining: newRemaining,
          message: "ساختار پاسخ نامعتبر بود: " + (err as Error).message,
        },
        502
      );
    }

    // ======================================================================
    // 12. ذخیره در cache
    // ======================================================================
    await admin.from("ai_cache").upsert(
      {
        user_id: user.id,
        cache_key: cacheKey,
        feature,
        payload: validated,
      },
      { onConflict: "user_id,cache_key" }
    );

    // ======================================================================
    // 13. پاسخ موفق
    // ======================================================================
    return jsonResponse({
      ok: true,
      cached: false,
      data: validated,
      remaining: newRemaining,
    });
  } catch (err) {
    console.error("AI Proxy unexpected error:", err);
    return jsonResponse(
      {
        ok: false,
        error: "server_error",
        message: String((err as Error)?.message || err),
      },
      500
    );
  }
});
