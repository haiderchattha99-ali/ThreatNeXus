// ThreatNeXus PKCERT deck — Phase 9B.1 premium redesign.
// Generates docs/presentation/ThreatNeXus-PKCERT-Deck.pptx directly.
// Palette + fonts + layout rules: docs/presentation/STYLE_GUIDE.md "Visual system v2".
const pptxgen = require("pptxgenjs");

const OUT = process.argv[2];
if (!OUT) { console.error("usage: node build-deck.js <output.pptx>"); process.exit(1); }

// ---- palette (frontend/src/theme/tokens.js) ----
const BG = "0A1210";
const PANEL = "0F1A16";
const GREEN = "35C477";
const TEXT = "EAF1F9";
const MUTED = "9DAFC2";
const CRIT = "F2617A";
const HIGH = "E8A33D";

const FONT = "Calibri";
const TOTAL = 17;

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5in — must be set before adding slides
pres.author = "ThreatNeXus";
pres.title = "ThreatNeXus — PKCERT Presentation Deck";

const MX = 0.6;
const CW = 13.333 - 2 * MX;

function shadow() {
  // fresh object every call — pptxgenjs mutates shadow options in place
  return { type: "outer", color: "000000", opacity: 0.35, blur: 6, offset: 2, angle: 90 };
}

function newSlide() {
  const s = pres.addSlide();
  s.background = { color: BG };
  return s;
}

// Kicker + title + footer chrome shared by every content slide (the deck's one repeated motif,
// per STYLE_GUIDE.md — no accent line, no color bar, just the kicker label itself).
function addChrome(s, { kicker, title, page, titleSize = 34 }) {
  s.addText(kicker.toUpperCase(), {
    x: MX, y: 0.48, w: CW, h: 0.32,
    fontFace: FONT, fontSize: 13, bold: true, color: GREEN, charSpacing: 2, margin: 0,
  });
  s.addText(title, {
    x: MX, y: 0.8, w: CW, h: 0.95,
    fontFace: FONT, fontSize: titleSize, bold: true, color: TEXT, margin: 0, valign: "top",
  });
  if (page) {
    s.addText("ThreatNeXus — PKCERT Technical Review", {
      x: MX, y: 7.05, w: 8, h: 0.3, fontFace: FONT, fontSize: 10, color: MUTED, margin: 0,
    });
    s.addText(`${String(page).padStart(2, "0")} / ${TOTAL}`, {
      x: 13.333 - MX - 2, y: 7.05, w: 2, h: 0.3, fontFace: FONT, fontSize: 10, color: MUTED,
      align: "right", margin: 0,
    });
  }
}

function addBullets(s, items, { x, y, w, h, size = 17, color = TEXT, gap = 10 }) {
  const paras = items.map((t) => ({
    text: t, options: { bullet: { code: "25CF", color: GREEN, indent: 18 }, color, paraSpaceAfter: gap },
  }));
  s.addText(paras, { x, y, w, h, fontFace: FONT, fontSize: size, valign: "top", margin: 0, lineSpacingMultiple: 1.15 });
}

function addCard(s, { x, y, w, h, title, body, titleColor = TEXT, titleSize = 16, bodySize = 12.5 }) {
  s.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.08, fill: { color: PANEL }, line: { color: "1C2B24", width: 1 }, shadow: shadow(),
  });
  s.addText(title, {
    x: x + 0.22, y: y + 0.16, w: w - 0.44, h: 0.4, fontFace: FONT, fontSize: titleSize, bold: true,
    color: titleColor, margin: 0, valign: "top",
  });
  if (body) {
    s.addText(body, {
      x: x + 0.22, y: y + 0.16 + 0.4, w: w - 0.44, h: h - 0.16 - 0.4 - 0.12, fontFace: FONT,
      fontSize: bodySize, color: MUTED, margin: 0, valign: "top", lineSpacingMultiple: 1.1,
    });
  }
}

function addStep(s, { x, y, w, h, label, sub }) {
  s.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.06, fill: { color: PANEL }, line: { color: GREEN, width: 1 },
  });
  s.addText(
    [{ text: label, options: { bold: true, color: TEXT, fontSize: 12.5, breakLine: !!sub } },
     ...(sub ? [{ text: sub, options: { color: MUTED, fontSize: 9 } }] : [])],
    { x: x + 0.05, y, w: w - 0.1, h, fontFace: FONT, align: "center", valign: "middle", margin: 0 }
  );
}

function addArrow(s, { x, y, size = 0.22 }) {
  s.addShape(pres.ShapeType.rightArrow, { x, y: y - size / 2, w: size, h: size, fill: { color: GREEN }, line: { type: "none" } });
}

function addStat(s, { x, y, w, number, label }) {
  s.addText(number, { x, y, w, h: 0.9, fontFace: FONT, fontSize: 52, bold: true, color: GREEN, align: "center", margin: 0 });
  s.addText(label, { x, y: y + 0.92, w, h: 0.6, fontFace: FONT, fontSize: 12, color: MUTED, align: "center", margin: 0, valign: "top" });
}

function bookendSlide({ eyebrow, title, subtitle, tagline, page }) {
  const s = newSlide();
  s.addText(eyebrow, {
    x: 0, y: 2.55, w: 13.333, h: 0.35, fontFace: FONT, fontSize: 13, bold: true, color: GREEN,
    align: "center", charSpacing: 3, margin: 0,
  });
  s.addText(title, {
    x: 0.8, y: 2.95, w: 13.333 - 1.6, h: 1.3, fontFace: FONT, fontSize: 54, bold: true, color: TEXT,
    align: "center", margin: 0, valign: "middle",
  });
  if (subtitle) {
    s.addText(subtitle, {
      x: 1.3, y: 4.15, w: 13.333 - 2.6, h: 0.6, fontFace: FONT, fontSize: 19, color: MUTED,
      align: "center", margin: 0, italic: true,
    });
  }
  if (tagline) {
    s.addText(tagline, {
      x: 1.3, y: 4.75, w: 13.333 - 2.6, h: 0.7, fontFace: FONT, fontSize: 14, color: MUTED,
      align: "center", margin: 0,
    });
  }
  return s;
}

// ---------------------------------------------------------------------------
// Slide 1 — Title
// ---------------------------------------------------------------------------
{
  const s = bookendSlide({
    eyebrow: "RESEARCH PROTOTYPE — PKCERT/NCERT INTERNSHIP",
    title: "ThreatNeXus",
    subtitle: "Connecting Intelligence with Action",
    tagline: "A defensive CERT triage and constituent-notification workflow",
    page: 1,
  });
  s.addNotes(
    "Open with the positioning line before anything else: ThreatNeXus is a research prototype, built " +
    "during a PKCERT/NCERT internship. It's not a deployed system, and I'm not claiming otherwise today. " +
    "Setting that expectation first makes every claim that follows easier to trust, not harder. " +
    "Don't overclaim: no production-ready, no deployed, no national-scale framing."
  );
}

// ---------------------------------------------------------------------------
// Slide 2 — Opening hook
// ---------------------------------------------------------------------------
{
  const s = newSlide();
  addChrome(s, { kicker: "The problem", title: "A report comes back. Nobody can say if it's new.", page: 2, titleSize: 32 });
  addBullets(s, [
    "An analyst re-triages the same exposure by hand, from memory, under time pressure",
    "Evidence lives across six provider tabs, never in one record",
    "Nothing ties today's report to the one from three months ago",
  ], { x: MX, y: 2.6, w: CW - 1.5, h: 3.5, size: 19, gap: 20 });
  s.addNotes(
    "Be concrete, not abstract. Don't open with 'cyberattacks are increasing' — open with the exact " +
    "failure: a CERT receives the same exposure report a second time, months later, and the process has " +
    "no way to connect it to the first one. It looks brand new. Nobody can say whether it was fixed, " +
    "whether it's recurring, or who's accountable for it. This is a workflow problem, not a claim that " +
    "any specific incident happened this way."
  );
}

// ---------------------------------------------------------------------------
// Slide 3 — Why fragmented CTI slows response
// ---------------------------------------------------------------------------
{
  const s = newSlide();
  addChrome(s, { kicker: "Why it breaks down", title: "Why fragmented CTI slows response", page: 3 });
  addBullets(s, [
    "One provider, one portal, one login — repeated six times over",
    "Judgment happens from memory, not from a durable evidence trail",
    "A notification can leave without a second reviewer ever seeing it",
    "When it's over, there's no record of who decided what, or why",
  ], { x: MX, y: 2.2, w: CW - 1, h: 4, size: 18, gap: 22 });
  s.addNotes(
    "Walk through each bullet as a real behavior, not a hypothetical — provider portals genuinely are " +
    "separate systems with separate logins; evidence genuinely does get judged from memory under time " +
    "pressure; a notification genuinely can go out today without independent review, in a manual " +
    "process. Don't imply every CERT works this exact way — frame it as the common failure mode this " +
    "project was built to close."
  );
}

// ---------------------------------------------------------------------------
// Slide 4 — What ThreatNeXus solves
// ---------------------------------------------------------------------------
{
  const s = newSlide();
  addChrome(s, { kicker: "The solution", title: "One workflow. One record.\nOne accountable analyst per decision.", page: 4, titleSize: 32 });
  s.addText(
    "A flat exposure report becomes a persistent, deduplicated Finding — enriched, scored, triaged, " +
    "and closed with a named human attached to every step that matters.",
    { x: MX, y: 3.05, w: CW - 2, h: 1.4, fontFace: FONT, fontSize: 18, color: MUTED, margin: 0, valign: "top", lineSpacingMultiple: 1.2 }
  );
  s.addNotes(
    "Say the bold line exactly as written, then pause. This is the one line the rest of the talk " +
    "supports — it's worth letting it land before moving on. 'Persistent, deduplicated Finding' is a " +
    "real, tested claim — don't extend it into 'never loses a report' or any absolute."
  );
}

// ---------------------------------------------------------------------------
// Slide 5 — The end-to-end workflow (diagram)
// ---------------------------------------------------------------------------
{
  const s = newSlide();
  addChrome(s, { kicker: "The workflow", title: "Upload to action, in one audited chain", page: 5, titleSize: 30 });
  const steps = [
    { label: "Upload" }, { label: "Triage" }, { label: "Enrich" },
    { label: "Map", sub: "ATT&CK/CSF/CIS" }, { label: "AI draft", sub: "optional" },
    { label: "Review" }, { label: "Act" },
  ];
  const boxW = 1.5, boxH = 1.0, arrowW = 0.24, y = 3.15;
  let x = MX;
  steps.forEach((st, i) => {
    addStep(s, { x, y, w: boxW, h: boxH, label: st.label, sub: st.sub });
    x += boxW;
    if (i < steps.length - 1) { addArrow(s, { x, y: y + boxH / 2, size: arrowW }); x += arrowW; }
  });
  s.addText("Every arrow writes its own audit event. Nothing skips a step.", {
    x: MX, y: y + boxH + 0.45, w: CW, h: 0.5, fontFace: FONT, fontSize: 15, italic: true, color: MUTED,
    align: "center", margin: 0,
  });
  s.addNotes(
    "Walk the arrow chain left to right, once, slowly. Emphasize 'every arrow writes its own audit " +
    "event' — that's implemented at the service layer specifically so a missing audit call fails a " +
    "test rather than shipping silently. The AI-draft step is optional and off by default — say that " +
    "here briefly. This is the map the live demo will walk physically."
  );
}

// ---------------------------------------------------------------------------
// Slide 6 — Live product surface
// ---------------------------------------------------------------------------
{
  const s = newSlide();
  addChrome(s, { kicker: "The product", title: "Every number says where it came from", page: 6, titleSize: 30 });
  s.addShape(pres.ShapeType.roundRect, {
    x: MX, y: 2.15, w: CW, h: 3.9, rectRadius: 0.08, fill: { color: PANEL },
    line: { color: "2A3B33", width: 1.5, dashType: "dash" },
  });
  s.addText(
    [
      { text: "SCREENSHOT PENDING\n", options: { bold: true, color: GREEN, fontSize: 15, breakLine: true } },
      { text: "Dashboard overview — see SCREENSHOT_PLAN.md, slot P-01", options: { color: MUTED, fontSize: 13 } },
    ],
    { x: MX, y: 2.15, w: CW, h: 3.9, align: "center", valign: "middle", fontFace: FONT, margin: 0 }
  );
  s.addText(
    "value  ·  availability  ·  source  ·  as-of  —  on every tile. Unknown is never rendered as zero.",
    { x: MX, y: 6.2, w: CW, h: 0.5, fontFace: FONT, fontSize: 14, color: MUTED, align: "center", margin: 0 }
  );
  s.addNotes(
    "This is the first look at the actual running application. Point at the four-part tuple on every " +
    "tile — value, availability, source, as-of — and say the sentence exactly: nothing on this screen " +
    "is estimated, and a figure that can't be computed never renders as zero. If presenting live, this " +
    "is the natural point to switch to the real application in a browser instead of the slide. Don't " +
    "caption a placeholder as if it were a real screenshot."
  );
}

// ---------------------------------------------------------------------------
// Slide 7 — Provider stack (grid)
// ---------------------------------------------------------------------------
{
  const s = newSlide();
  addChrome(s, { kicker: "The evidence sources", title: "A six-provider intelligence stack", page: 7, titleSize: 30 });
  const providers = [
    { name: "AbuseIPDB", domain: "IP reputation" },
    { name: "NVD + KEV + EPSS", domain: "Vulnerability metadata" },
    { name: "Censys", domain: "Internet exposure" },
    { name: "GreyNoise", domain: "Internet noise / reputation" },
    { name: "Shodan", domain: "Exposed services" },
    { name: "Netlas", domain: "Cross-source exposure" },
  ];
  const cols = 3, rows = 2, gap = 0.25;
  const cardW = (CW - gap * (cols - 1)) / cols, cardH = 1.35;
  providers.forEach((p, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    addCard(s, {
      x: MX + col * (cardW + gap), y: 2.2 + row * (cardH + gap), w: cardW, h: cardH,
      title: p.name, body: p.domain, titleSize: 15, bodySize: 12,
    });
  });
  s.addText("All optional. All fail safe. One shared, rate-limited execution path.", {
    x: MX, y: 2.2 + 2 * cardH + gap + 0.25, w: CW, h: 0.5, fontFace: FONT, fontSize: 14, italic: true,
    color: MUTED, align: "center", margin: 0,
  });
  s.addNotes(
    "Name what each provider adds in one breath, without dwelling — the point is breadth and " +
    "uniformity, not depth on any one provider. Every one of these is optional, and a missing key " +
    "disables exactly one provider, never the whole application. Never state or imply uptime, latency, " +
    "or accuracy for any provider — none of that is measured anywhere in the product."
  );
}

// ---------------------------------------------------------------------------
// Slide 8 — Evidence, not proof
// ---------------------------------------------------------------------------
{
  const s = newSlide();
  addChrome(s, { kicker: "Governance", title: "Evidence, not proof", page: 8 });
  s.addText(
    "Provider data supports an analyst's decision. It never replaces the analyst who makes it.",
    { x: MX, y: 2.15, w: CW, h: 0.6, fontFace: FONT, fontSize: 17, color: TEXT, margin: 0 }
  );
  addCard(s, { x: MX, y: 3.0, w: CW / 2 - 0.15, h: 2.3, title: "Unknown is never zero", titleSize: 20, titleColor: GREEN });
  addCard(s, {
    x: MX + CW / 2 + 0.15, y: 3.0, w: CW / 2 - 0.15, h: 2.3,
    title: "Applied · Not available · Not applicable",
    body: "Never collapsed into a false “clean.”", titleSize: 18, titleColor: GREEN,
  });
  s.addNotes(
    "This is a governance slide, not a features slide — slow down here. A high reputation score, an " +
    "open port, a suspicious classification: none of it closes a case or sends a notification by " +
    "itself. An analyst reads it and decides. Land the phrase 'unknown is never zero' specifically — " +
    "it's the rule that makes every other number on the dashboard trustworthy."
  );
}

// ---------------------------------------------------------------------------
// Slide 9 — AI assistance
// ---------------------------------------------------------------------------
{
  const s = newSlide();
  addChrome(s, { kicker: "AI assistance", title: "Drafts only — off by default", page: 9, titleSize: 30 });
  addBullets(s, [
    "Disabled by default. No live AI provider ships in this codebase.",
    "Drafts a mapping suggestion or a finding summary — nothing more",
    "A provider gets one method and a stripped snapshot: no database access, no capability token",
    "Every draft needs a named human's accept before it counts as anything",
  ], { x: MX, y: 2.25, w: 7.6, h: 4, size: 15.5, gap: 16 });
  const fx = MX + 8.0, fw = CW - 8.0;
  const chip = (label, y) => s.addShape(pres.ShapeType.roundRect, {
    x: fx, y, w: fw, h: 0.55, rectRadius: 0.06, fill: { color: PANEL }, line: { color: GREEN, width: 1 },
  }) && s.addText(label, { x: fx, y, w: fw, h: 0.55, fontFace: FONT, fontSize: 12.5, bold: true, color: TEXT, align: "center", valign: "middle", margin: 0 });
  chip("Provider", 2.6);
  addArrow(s, { x: fx + fw / 2 - 0.11, y: 3.25, size: 0.2 });
  chip("Suggestion (inert)", 3.42);
  addArrow(s, { x: fx + fw / 2 - 0.11, y: 4.07, size: 0.2 });
  chip("Human decision", 4.24);
  s.addNotes(
    "Get ahead of the AI question before anyone asks it. AI here does less than people expect, " +
    "deliberately. It's off by default, and there's no live AI provider wired up in this codebase at " +
    "all today. When it is enabled, it drafts a suggestion; a human decides. Never say 'AI decides' or " +
    "'AI approves' — no such measurement exists."
  );
}

// ---------------------------------------------------------------------------
// Slide 10 — ATT&CK mapping and evidence integrity
// ---------------------------------------------------------------------------
{
  const s = newSlide();
  addChrome(s, { kicker: "Framework mapping", title: "ATT&CK mapping requires observed behaviour", page: 10, titleSize: 28 });
  s.addText(
    "Exposure, a CVE, a risk score — each is individually insufficient, and the rule is enforced " +
    "server-side, whether the mapping came from an analyst or an accepted AI suggestion.",
    { x: MX, y: 2.15, w: CW, h: 0.9, fontFace: FONT, fontSize: 16, color: MUTED, margin: 0, lineSpacingMultiple: 1.2 }
  );
  const insufficient = ["Exposed service", "A CVE", "KEV / EPSS", "Reputation score", "Risk score"];
  let ix = MX;
  insufficient.forEach((t) => {
    const w = 0.42 + t.length * 0.1;
    s.addShape(pres.ShapeType.roundRect, { x: ix, y: 3.35, w, h: 0.5, rectRadius: 0.25, fill: { color: PANEL }, line: { color: CRIT, width: 1 } });
    s.addText(t, { x: ix, y: 3.35, w, h: 0.5, fontFace: FONT, fontSize: 11.5, color: MUTED, align: "center", valign: "middle", margin: 0, strike: true });
    ix += w + 0.18;
  });
  s.addText("— each individually insufficient", { x: ix + 0.05, y: 3.35, w: 3, h: 0.5, fontFace: FONT, fontSize: 12, color: MUTED, valign: "middle", margin: 0, italic: true });
  s.addShape(pres.ShapeType.roundRect, { x: MX, y: 4.35, w: 4.6, h: 0.65, rectRadius: 0.32, fill: { color: PANEL }, line: { color: GREEN, width: 1.5 } });
  s.addText("Observed adversary behaviour — required", {
    x: MX, y: 4.35, w: 4.6, h: 0.65, fontFace: FONT, fontSize: 13.5, bold: true, color: GREEN, align: "center", valign: "middle", margin: 0,
  });
  s.addNotes(
    "This is a specific, checkable claim, so make it specific: an ATT&CK mapping justified only by 'the " +
    "host is exposed' or 'the risk score is high' is refused by the server, not just discouraged in the " +
    "interface. The same rule applies whether the mapping came from an analyst typing it in or from an " +
    "accepted AI suggestion. Don't claim full ATT&CK catalogue verification for NIST CSF/CIS — those two " +
    "are format-checked, not existence-verified."
  );
}

// ---------------------------------------------------------------------------
// Slide 11 — Security controls
// ---------------------------------------------------------------------------
{
  const s = newSlide();
  addChrome(s, { kicker: "Security controls", title: "Four controls, stated specifically", page: 11, titleSize: 30 });
  const controls = [
    { title: "Capability-based RBAC", body: "Backend is the only enforcement boundary. No role inherits another's authority." },
    { title: "Audited writes", body: "Every write is audited from the service layer — never the controller." },
    { title: "Rate limiting", body: "Independent buckets for auth, upload, and provider execution." },
    { title: "Secret redaction", body: "No secret ever reaches a log, a response, or the browser bundle — checked every CI push." },
  ];
  const gap = 0.25, cardW = (CW - gap) / 2, cardH = 1.7;
  controls.forEach((c, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    addCard(s, { x: MX + col * (cardW + gap), y: 2.2 + row * (cardH + gap), w: cardW, h: cardH, title: c.title, body: c.body, titleSize: 17, bodySize: 13 });
  });
  s.addNotes(
    "This is a checklist slide for anyone doing technical diligence — deliver it as a checklist, not a " +
    "story. An analyst who drafts a notification structurally cannot also approve it — that's a 403 the " +
    "system returns, not a policy someone has to remember. Don't say 'enterprise-grade' or 'bank-level' " +
    "— name the mechanism instead."
  );
}

// ---------------------------------------------------------------------------
// Slide 12 — Architecture (diagram)
// ---------------------------------------------------------------------------
{
  const s = newSlide();
  addChrome(s, { kicker: "Architecture", title: "One door in, one door out", page: 12, titleSize: 32 });
  const chain = [
    { label: "Frontend", sub: "React · Vite" },
    { label: "REST API", sub: "Express" },
    { label: "Services", sub: "domain logic" },
    { label: "PostgreSQL", sub: "via Prisma" },
  ];
  const boxW = 2.2, boxH = 1.1, arrowW = 0.3, y = 2.5;
  let x = MX + 0.3;
  chain.forEach((c, i) => {
    addStep(s, { x, y, w: boxW, h: boxH, label: c.label, sub: c.sub });
    x += boxW;
    if (i < chain.length - 1) { addArrow(s, { x, y: y + boxH / 2, size: arrowW }); x += arrowW; }
  });
  // Provider adapters branch off Services, dashed — human-triggered only, not part of the main chain.
  const svcX = MX + 0.3 + (boxW + arrowW) * 2;
  s.addShape(pres.ShapeType.line, {
    x: svcX + boxW / 2, y: y + boxH, w: 0, h: 0.7,
    line: { color: MUTED, width: 1.25, dashType: "dash" },
  });
  addStep(s, { x: svcX + boxW / 2 - 1.4, y: y + boxH + 0.7, w: 2.8, h: 0.85, label: "Provider adapters", sub: "human-triggered lookup only" });
  s.addText(
    "The frontend never reaches a provider or the database directly — the backend is the only authorization boundary.",
    { x: MX, y: 5.85, w: CW, h: 0.7, fontFace: FONT, fontSize: 14, italic: true, color: MUTED, align: "center", margin: 0 }
  );
  s.addNotes(
    "Walk left to right once: frontend talks only to the REST API; the API talks to domain services; " +
    "services talk to Postgres and, only on a human-triggered request, to a provider. Land the point " +
    "that the frontend never reaches a provider or the database directly. Don't describe this as " +
    "microservices or distributed — it's a single Express application with a modular service layer."
  );
}

// ---------------------------------------------------------------------------
// Slide 13 — Demo path for PKCERT reviewers
// ---------------------------------------------------------------------------
{
  const s = newSlide();
  addChrome(s, { kicker: "Live demonstration", title: "What a PKCERT reviewer will see", page: 13, titleSize: 30 });
  const beats = [
    { t: "Dashboard integrity model", d: "Sourced figures, unknown never rendered as zero" },
    { t: "A Finding's risk explanation", d: "Applied / Not available / Not applicable, factor by factor" },
    { t: "A closure refused to its own requester", d: "Approved instead by a separate reviewer" },
    { t: "A weak ATT&CK justification refused", d: "Server-side, not a UI-only check" },
    { t: "Export vs. delivery", d: "Tracked as two separate, honest events" },
  ];
  let y = 2.15;
  beats.forEach((b, i) => {
    s.addShape(pres.ShapeType.ellipse, { x: MX, y, w: 0.42, h: 0.42, fill: { color: PANEL }, line: { color: GREEN, width: 1.5 } });
    s.addText(String(i + 1), { x: MX, y, w: 0.42, h: 0.42, fontFace: FONT, fontSize: 15, bold: true, color: GREEN, align: "center", valign: "middle", margin: 0 });
    s.addText(
      [{ text: b.t, options: { bold: true, color: TEXT, fontSize: 16, breakLine: true } },
       { text: b.d, options: { color: MUTED, fontSize: 12.5 } }],
      { x: MX + 0.6, y: y - 0.06, w: CW - 0.6, h: 0.75, fontFace: FONT, margin: 0, valign: "top" }
    );
    y += 0.92;
  });
  s.addNotes(
    "Preview the exact sequence about to happen, so the audience knows what to watch for. This slide IS " +
    "the demo cue — transition directly into the live walkthrough from here. Say 'what you're about to " +
    "see,' not 'what PKCERT will use in production.'"
  );
}

// ---------------------------------------------------------------------------
// Slide 14 — Meet the team
// ---------------------------------------------------------------------------
{
  const s = newSlide();
  addChrome(s, { kicker: "The team", title: "Meet the team", page: 14 });
  const team = [
    { name: "M. Ismail", role: "Threat Intelligence & System Coordination" },
    { name: "Ali Haider", role: "Software Engineering & Backend Systems" },
    { name: "Aun Zulfiqar", role: "Frontend & UX" },
    { name: "Eshaal Khan", role: "Security Workflow & QA" },
  ];
  const gap = 0.3, cardW = (CW - gap * 3) / 4, cardH = 3.2, y = 2.4, circleD = 1.0;
  team.forEach((m, i) => {
    const x = MX + i * (cardW + gap);
    const cx = x + cardW / 2 - circleD / 2;
    s.addShape(pres.ShapeType.ellipse, { x: cx, y: y + 0.25, w: circleD, h: circleD, fill: { color: PANEL }, line: { color: GREEN, width: 1.5 } });
    const initials = m.name.split(" ").map((p) => p.replace(".", "")[0]).join("").slice(0, 2).toUpperCase();
    s.addText(initials, { x: cx, y: y + 0.25, w: circleD, h: circleD, fontFace: FONT, fontSize: 22, bold: true, color: GREEN, align: "center", valign: "middle", margin: 0 });
    s.addText(m.name, { x, y: y + 1.5, w: cardW, h: 0.4, fontFace: FONT, fontSize: 15, bold: true, color: TEXT, align: "center", margin: 0 });
    s.addText(m.role, { x: x + 0.1, y: y + 1.9, w: cardW - 0.2, h: 0.9, fontFace: FONT, fontSize: 11.5, color: MUTED, align: "center", margin: 0, valign: "top" });
  });
  s.addNotes(
    "Keep this brief and factual — name, one-line role, move on. This slide exists so a PKCERT reviewer " +
    "knows who to ask a follow-up question, not to sell anything. Names and roles are sourced directly " +
    "from README.md's own Team section."
  );
}

// ---------------------------------------------------------------------------
// Slide 15 — Validation proof
// ---------------------------------------------------------------------------
{
  const s = newSlide();
  addChrome(s, { kicker: "Validation", title: "Proof, not assertion", page: 15 });
  const stats = [
    { n: "23", l: "additive-only migrations" },
    { n: "145", l: "backend test files" },
    { n: "9", l: "browser-suite specs" },
    { n: "9", l: "evaluator gates vs.\nhand-authored ground truth" },
  ];
  const colW = CW / 4;
  stats.forEach((st, i) => addStat(s, { x: MX + i * colW, y: 2.7, w: colW, number: st.n, label: st.l }));
  s.addText("CI on every push — schema integrity, secrets scan, zero live provider calls, proven structurally.", {
    x: MX, y: 4.9, w: CW, h: 0.6, fontFace: FONT, fontSize: 14, italic: true, color: MUTED, align: "center", margin: 0,
  });
  s.addNotes(
    "Let the numbers breathe — don't over-narrate each one. The evaluators are the actual bar this " +
    "project holds itself to: a human wrote down the correct answer by hand, and the real production " +
    "code has to reproduce it exactly. These are test/evaluator/CI counts, not a security-audit " +
    "certification — don't imply an external audit occurred."
  );
}

// ---------------------------------------------------------------------------
// Slide 16 — Honest limits and roadmap
// ---------------------------------------------------------------------------
{
  const s = newSlide();
  addChrome(s, { kicker: "Honest limits", title: "What this isn't, yet", page: 16, titleSize: 32 });
  addBullets(s, [
    "No in-app user management yet",
    "No production deployment — Docker Compose only",
    "Finding closure has no UI write path yet (the recurrence engine is tested and correct regardless)",
    "No live AI provider, no live Shadowserver feed — deliberate scope boundaries",
  ], { x: MX, y: 2.15, w: CW, h: 3, size: 16, gap: 16 });
  s.addShape(pres.ShapeType.roundRect, { x: MX, y: 5.4, w: CW, h: 0.75, rectRadius: 0.08, fill: { color: PANEL }, line: { color: "1C2B24", width: 1 } });
  s.addText(
    [{ text: "Next:  ", options: { bold: true, color: GREEN } },
     { text: "a seventh provider, in-app user management, a production write path for Finding closure." }],
    { x: MX + 0.25, y: 5.4, w: CW - 0.5, h: 0.75, fontFace: FONT, fontSize: 13.5, color: TEXT, valign: "middle", margin: 0 }
  );
  s.addNotes(
    "Do not rush or skip this slide. Say each limit plainly, without softening language. This is the " +
    "slide that makes every earlier claim believable. Don't follow any of the four limits with 'but " +
    "we're fixing that soon' — the roadmap line already covers direction."
  );
}

// ---------------------------------------------------------------------------
// Slide 17 — Close
// ---------------------------------------------------------------------------
{
  const s = bookendSlide({
    eyebrow: "READY FOR TECHNICAL REVIEW",
    title: "ThreatNeXus",
    subtitle: "a working, tested, audited analyst workflow —",
    tagline: "with its gaps stated as plainly as its guarantees.",
    page: 17,
  });
  s.addText("Questions.", {
    x: 0, y: 5.6, w: 13.333, h: 0.6, fontFace: FONT, fontSize: 20, bold: true, color: GREEN, align: "center", margin: 0,
  });
  s.addNotes(
    "Close on the same tagline the deck opened with. State the 'ready for technical review' framing " +
    "exactly as worded: it's a specific claim (tested, audited, working), not a general one (finished, " +
    "production-ready). Invite questions and leave the slide up. Do not extend to 'ready for " +
    "deployment' or 'ready for adoption,' even if asked directly."
  );
}

pres.writeFile({ fileName: OUT }).then(() => {
  console.log("Wrote", OUT);
}).catch((e) => { console.error(e); process.exit(1); });
