// Tourly — transcribe a vidzflow MP4 via OpenAI Whisper.
// Deploy: supabase functions deploy transcribe
// Secrets: supabase secrets set OPENAI_API_KEY=sk-...
//
// POST { mp4Url: string, videoId: string }
// → { ok: true, segments: [{ start, end, text }], cached?: boolean }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_MP4_HOST = /^https:\/\/r2\.vidzflow\.com\//;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function mapSegments(raw: Array<{ start?: number; end?: number; text?: string }>) {
  return raw
    .map((s) => ({
      start: +(s.start ?? 0).toFixed(2),
      end: +(s.end ?? 0).toFixed(2),
      text: (s.text || "").trim(),
    }))
    .filter((s) => s.text.length > 0 && s.end > s.start);
}

const SUB_MAX_SEC = 3.5;
const SUB_MAX_CHARS = 48;
const SUB_MAX_WORDS = 7;

function splitSubtitleText(text: string): string[] {
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const words = text.split(" ");
  const chunks: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) {
      chunks.push(cur.join(" "));
      cur = [];
    }
  };
  for (const w of words) {
    const trial = cur.concat(w).join(" ");
    if (cur.length && (cur.length >= SUB_MAX_WORDS || trial.length > SUB_MAX_CHARS)) flush();
    cur.push(w);
    if (/[.!?]$/.test(w)) flush();
  }
  flush();
  return chunks;
}

function chunkSegment(seg: { start: number; end: number; text: string }) {
  const start = seg.start;
  const end = seg.end;
  const text = seg.text.trim();
  if (!text || end <= start) return [] as Array<{ start: number; end: number; text: string }>;

  const phrases = splitSubtitleText(text);
  const totalChars = phrases.reduce((n, p) => n + p.length, 0) || 1;
  const dur = end - start;
  let t = start;
  const raw: Array<{ start: number; end: number; text: string }> = [];
  phrases.forEach((p, i) => {
    const d = i === phrases.length - 1 ? end - t : dur * (p.length / totalChars);
    raw.push({ start: t, end: t + d, text: p });
    t += d;
  });

  const out: Array<{ start: number; end: number; text: string }> = [];
  for (const c of raw) {
    const cd = c.end - c.start;
    if (cd <= SUB_MAX_SEC) {
      out.push({ start: +c.start.toFixed(2), end: +c.end.toFixed(2), text: c.text });
      continue;
    }
    let parts = splitSubtitleText(c.text);
    if (parts.length <= 1) {
      const ws = c.text.split(" ");
      const half = Math.ceil(ws.length / 2);
      parts = [ws.slice(0, half).join(" "), ws.slice(half).join(" ")].filter(Boolean);
    }
    const tc = parts.reduce((n, p) => n + p.length, 0) || 1;
    let tt = c.start;
    parts.forEach((p, i) => {
      const d = i === parts.length - 1 ? c.end - tt : cd * (p.length / tc);
      out.push({ start: +tt.toFixed(2), end: +(tt + d).toFixed(2), text: p });
      tt += d;
    });
  }
  return out.filter((s) => s.text && s.end > s.start);
}

function chunkSegments(segments: Array<{ start: number; end: number; text: string }>) {
  const out: Array<{ start: number; end: number; text: string }> = [];
  for (const seg of segments) out.push(...chunkSegment(seg));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) return json({ ok: false, error: "OPENAI_API_KEY not configured" }, 503);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "Supabase env missing" }, 503);

  let body: { mp4Url?: string; videoId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const mp4Url = (body.mp4Url || "").trim();
  const videoId = (body.videoId || "").trim();
  if (!videoId || !mp4Url) return json({ ok: false, error: "mp4Url and videoId required" }, 400);
  if (!ALLOWED_MP4_HOST.test(mp4Url)) return json({ ok: false, error: "mp4Url host not allowed" }, 400);

  const sb = createClient(supabaseUrl, serviceKey);

  // Cache hit
  const { data: cached, error: cacheErr } = await sb
    .from("transcription_cache")
    .select("segments")
    .eq("video_id", videoId)
    .maybeSingle();

  if (cacheErr) return json({ ok: false, error: cacheErr.message }, 500);
  if (cached?.segments && Array.isArray(cached.segments)) {
    return json({ ok: true, segments: chunkSegments(mapSegments(cached.segments)), cached: true });
  }

  // Fetch MP4 and send to Whisper
  let mp4Res: Response;
  try {
    mp4Res = await fetch(mp4Url);
  } catch (e) {
    return json({ ok: false, error: "Failed to fetch MP4: " + String(e) }, 502);
  }
  if (!mp4Res.ok) return json({ ok: false, error: "MP4 fetch returned " + mp4Res.status }, 502);

  const mp4Blob = await mp4Res.blob();
  if (mp4Blob.size > 25 * 1024 * 1024) {
    return json({ ok: false, error: "Video exceeds Whisper 25MB limit" }, 413);
  }

  const form = new FormData();
  form.append("file", mp4Blob, "video.mp4");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");

  let whisperRes: Response;
  try {
    whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + openaiKey },
      body: form,
    });
  } catch (e) {
    return json({ ok: false, error: "Whisper request failed: " + String(e) }, 502);
  }

  const whisperText = await whisperRes.text();
  if (!whisperRes.ok) {
    return json({ ok: false, error: "Whisper error: " + whisperText }, whisperRes.status);
  }

  let whisperData: { segments?: Array<{ start?: number; end?: number; text?: string }> };
  try {
    whisperData = JSON.parse(whisperText);
  } catch {
    return json({ ok: false, error: "Invalid Whisper response" }, 502);
  }

  const segments = chunkSegments(mapSegments(whisperData.segments || []));
  if (!segments.length) return json({ ok: false, error: "No speech detected" }, 422);

  const { error: insertErr } = await sb.from("transcription_cache").upsert({
    video_id: videoId,
    segments,
  });
  if (insertErr) console.error("cache write failed:", insertErr.message);

  return json({ ok: true, segments, cached: false });
});
