import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.EVAL_BASE_URL || "http://localhost:3000";
const CASE_FILE = process.env.EVAL_CASES_FILE || path.join(process.cwd(), "evals/cases.json");
const REUSE_CONVERSATION = (process.env.EVAL_REUSE_CONVERSATION || "true").toLowerCase() !== "false";
const EVAL_EMAIL = process.env.EVAL_USER_EMAIL || "eval-runner@ollive.local";
const EVAL_NAME = process.env.EVAL_USER_NAME || "Eval Runner";
const EVAL_PASSWORD = process.env.EVAL_USER_PASSWORD || "eval-runner-password";

// Every /api/chat route calls requireSessionUser(), so the runner must hold a session
// cookie. Sign up once (or sign in if the eval user already exists) and reuse the
// Set-Cookie value on every request.
let sessionCookie = "";

async function signIn() {
  let res = await fetch(`${BASE_URL}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EVAL_EMAIL, name: EVAL_NAME, password: EVAL_PASSWORD }),
  });
  if (res.status === 409) {
    res = await fetch(`${BASE_URL}/api/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EVAL_EMAIL, password: EVAL_PASSWORD }),
    });
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(`Sign-in failed (${res.status}): ${payload?.error || "unknown"}`);
  }
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("Sign-in succeeded but no session cookie was returned");
  sessionCookie = setCookie.split(";")[0];
}

function includesCI(text, needle) {
  return text.toLowerCase().includes(needle.toLowerCase());
}

function sentenceWordPeaks(text) {
  const sentences = text.split(/[.!?]\s+/).filter(Boolean);
  let peak = 0;
  for (const s of sentences) {
    const words = s.trim().split(/\s+/).filter(Boolean).length;
    if (words > peak) peak = words;
  }
  return peak;
}

function containsLikelyAbsoluteClaim(text) {
  const patterns = [/\balways\b/i, /\bnever\b/i, /\bguaranteed\b/i, /\b100%\b/i];
  return patterns.some((p) => p.test(text));
}

async function queryModel(prompt, conversationId) {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessionCookie },
    body: JSON.stringify({ message: prompt, conversationId }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${payload?.error || "unknown"}`);

  const content = payload?.message?.content;
  if (typeof content !== "string") throw new Error("Unexpected response shape: missing message.content");
  return { content, conversationId: payload?.conversationId };
}

function evaluate(testCase, output) {
  const failures = [];
  const g = testCase.golden;

  if (g?.exact !== undefined && output.trim() !== g.exact.trim()) failures.push("golden.exact mismatch");
  if (g?.mustIncludeAll) for (const token of g.mustIncludeAll) if (!includesCI(output, token)) failures.push(`missing required token: ${token}`);
  if (g?.mustIncludeAny?.length && !g.mustIncludeAny.some((token) => includesCI(output, token))) failures.push(`missing one-of required tokens: ${g.mustIncludeAny.join(", ")}`);
  if (g?.mustNotInclude) for (const token of g.mustNotInclude) if (includesCI(output, token)) failures.push(`contains forbidden token: ${token}`);
  if (typeof g?.maxChars === "number" && output.length > g.maxChars) failures.push(`exceeds maxChars (${output.length} > ${g.maxChars})`);

  const q = testCase.quality;
  if (q?.factuality?.mustMentionFacts) for (const fact of q.factuality.mustMentionFacts) if (!includesCI(output, fact)) failures.push(`factuality: missing reference fact: ${fact}`);
  if (q?.factuality?.forbidAbsoluteClaims && containsLikelyAbsoluteClaim(output)) failures.push("factuality: contains likely absolute claim");
  if (q?.safety?.mustNotContain) for (const token of q.safety.mustNotContain) if (includesCI(output, token)) failures.push(`safety: forbidden token present: ${token}`);
  if (q?.style?.mustAvoid) for (const token of q.style.mustAvoid) if (includesCI(output, token)) failures.push(`style: disallowed phrase present: ${token}`);
  if (typeof q?.style?.maxSentenceWords === "number") {
    const peak = sentenceWordPeaks(output);
    if (peak > q.style.maxSentenceWords) failures.push(`style: sentence too long (${peak} > ${q.style.maxSentenceWords})`);
  }

  return { id: testCase.id, passed: failures.length === 0, failures, output };
}

async function main() {
  const cases = JSON.parse(fs.readFileSync(CASE_FILE, "utf-8"));
  await signIn();
  const results = [];
  let sharedConversationId;

  for (const c of cases) {
    try {
      const cid = REUSE_CONVERSATION ? sharedConversationId : undefined;
      const { content, conversationId } = await queryModel(c.prompt, cid);
      if (REUSE_CONVERSATION && conversationId) sharedConversationId = conversationId;
      results.push(evaluate(c, content));
    } catch (err) {
      results.push({ id: c.id, passed: false, failures: [err instanceof Error ? err.message : "Unknown eval error"], output: "" });
    }
  }

  const failed = results.filter((r) => !r.passed);
  const summary = {
    baseUrl: BASE_URL,
    reuseConversation: REUSE_CONVERSATION,
    sharedConversationId: sharedConversationId || null,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
  const outPath = path.join(process.cwd(), "evals/latest-report.json");
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

  console.log(`Eval run complete: ${summary.passed}/${summary.total} passed`);
  console.log(`Report: ${outPath}`);
  for (const f of failed) console.log(`- ${f.id}: ${f.failures.join("; ")}`);

  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
