const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const m = require("./matching.js");

const tax = {
  id: "seed-etax",
  name: "ขอใบกำกับภาษี",
  enabled: true,
  keywords: "ขอใบกำกับภาษี\nใบกำกับภาษี e-Tax",
  template: "เรียน คุณลูกค้า ทางเราได้ส่งใบกำกับภาษี (e-Tax) ไปแล้วค่ะ",
  countries: ["TH"],
  language: "th"
};
const billing = {
  id: "seed-billing",
  name: "ขอข้อมูลวางบิล",
  enabled: true,
  keywords: "ข้อมูลการวางบิล",
  template: "เรียน คุณลูกค้า รอบวางบิลของเราคือสิ้นเดือนค่ะ",
  countries: ["TH", "SG", "MY"],
  language: "en"
};
const overdue = {
  id: "seed-overdue",
  name: "สอบถามยอดค้าง",
  enabled: true,
  keywords: "สอบถามยอดค้าง\nOverdue Payment",
  template: "Dear customer, we will review the overdue balance.",
  countries: ["SG"],
  language: "en"
};
const rules = [tax, billing, overdue];

test("exact keyword match is case-sensitive and not a shorter fragment", function () {
  assert.equal(m.keywordHit(tax, {
    country: "TH",
    subject: "Re: Your Invoice (e-Tax) from Hungry Hub",
    body: "รบกวนขอใบกำกับภาษี และใบกำกับภาษี e-Tax ค่ะ"
  }), "ขอใบกำกับภาษี");
  assert.equal(m.keywordHit(tax, {
    country: "TH",
    subject: "e-Tax only",
    body: "please send e-Tax"
  }), "");
  assert.equal(m.keywordHit(overdue, {
    country: "SG",
    subject: "ยอดค้างชำระ",
    body: "follow up ยอดค้างชำระ"
  }), "");
  assert.equal(m.keywordHit(overdue, {
    country: "SG",
    subject: "overdue payment",
    body: ""
  }), "");
  assert.equal(m.keywordHit(overdue, {
    country: "SG",
    subject: "Re: Overdue Payment & Payment Terms",
    body: ""
  }), "Overdue Payment");
});

test("country filter and disabled rules do not match", function () {
  assert.equal(m.keywordHit(tax, { country: "MY", subject: "", body: "ขอใบกำกับภาษี" }), "");
  assert.equal(m.keywordHit(Object.assign({}, tax, { enabled: false }), {
    country: "TH",
    subject: "",
    body: "ขอใบกำกับภาษี"
  }), "");
  assert.equal(m.firstMatch({
    country: "MY",
    subject: "Request tax invoice",
    body: "ขอใบกำกับภาษี สำหรับการชำระเงินที่มาเลเซียค่ะ"
  }, rules), null);
});

test("the first matching enabled rule wins", function () {
  var hit = m.firstMatch({
    country: "TH",
    subject: "ตามบิล",
    body: "สอบถามข้อมูลการวางบิลค่ะ"
  }, rules);
  assert.equal(hit.rule.id, "seed-billing");
  assert.equal(hit.keyword, "ข้อมูลการวางบิล");
});

test("reply language is forced or detected from Thai characters", function () {
  assert.equal(m.resolveLanguage({ language: "th" }, { subject: "Hello", body: "English" }), "TH");
  assert.equal(m.resolveLanguage({ language: "en" }, { subject: "", body: "ขอใบกำกับภาษี" }), "EN");
  assert.equal(m.resolveLanguage({ language: "match" }, { subject: "Invoice", body: "ขอใบกำกับภาษี" }), "TH");
  assert.equal(m.resolveLanguage({ language: "match" }, { subject: "Invoice", body: "Please send the file" }), "EN");
});

test("template fill greets the sender and does not keep the generic greeting", function () {
  var th = m.templateAdapt(tax, {
    sender: "Centara Watergate Pavilion",
    subject: "Re: Your Invoice (e-Tax) from Hungry Hub"
  }, "TH", "ทีมบัญชี");
  assert.match(th.body, /^เรียน Centara Watergate Pavilion/);
  assert.doesNotMatch(th.body, /เรียน คุณลูกค้า/);
  assert.match(th.body, /ทางเราได้ส่งใบกำกับภาษี/);
  assert.match(th.body, /เรื่อง: Re: Your Invoice \(e-Tax\) from Hungry Hub/);
  assert.match(th.body, /ทีมบัญชี\s*$/);
  assert.equal(th.adapter, "template");

  var en = m.templateAdapt(overdue, {
    sender: "The Butcher's Wife (SG) <ap@example.com>",
    subject: "Re: Overdue Payment & Payment Terms"
  }, "EN");
  assert.match(en.body, /^Dear The Butcher's Wife \(SG\),/);
  assert.doesNotMatch(en.body, /Dear customer/i);
  assert.match(en.body, /Regarding: Re: Overdue Payment/);
  assert.match(en.body, /Hungry Hub Accounting/);
});

test("sheet rows round-trip and drop invalid ids", function () {
  const stamp = "2026-10-02T08:00:00.000Z";
  const values = m.rulesToSheetValues([
    tax,
    { id: "bad id", name: "x", enabled: true, keywords: "a", template: "b", countries: ["TH"], language: "th" },
    Object.assign({}, billing, { enabled: false })
  ], "staff@hungryhub.com", stamp);
  assert.deepEqual(values[0], m.RULE_HEADER);
  const back = m.rulesFromSheetValues(values);
  assert.equal(back.length, 2);
  assert.equal(back[0].id, "seed-etax");
  assert.equal(back[0].keywords, tax.keywords);
  assert.deepEqual(back[0].countries, ["TH"]);
  assert.equal(back[1].enabled, false);
  assert.equal(back[1].language, "en");
  assert.equal(m.keywordHit(back[1], { country: "TH", subject: "", body: "ข้อมูลการวางบิล" }), "");
});

test("search text cannot inject Gmail operators", function () {
  const cleaned = m.sanitizeSearchTerm('Invoice" from:ceo@evil.com newer_than:1d');
  assert.equal(cleaned.includes('"'), false);
  assert.equal(/\bfrom:/i.test(cleaned), false);
  assert.equal(/\bnewer_than:/i.test(cleaned), false);
  assert.equal(m.isGmailId("18f3ab90c1d2e3f4"), true);
  assert.equal(m.isGmailId("not an id"), false);
  assert.equal(m.isGmailId(""), false);
});

test("Apps Script source never sends mail", function () {
  const src = fs.readFileSync(path.join(__dirname, "Code.gs"), "utf8");
  const bridge = fs.readFileSync(path.join(__dirname, "Bridge.html"), "utf8");
  const forbidden = /GmailApp\.|MailApp\.|Drafts\.send|Messages\.send|drafts\.send|messages\.send|\.send\(\)|createDraftReply/;
  assert.equal(forbidden.test(src), false, "Code.gs contains a send call or GmailApp");
  assert.equal(forbidden.test(bridge), false, "Bridge.html contains a send call");
  assert.match(src, /Users\.Drafts\.create/);
  assert.equal(src.includes("LLM_API_KEY") && src.includes("getProperty"), true);
  assert.equal(/sk-[A-Za-z0-9]{10,}/.test(src + bridge), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "appsscript.json"), "utf8"));
  assert.equal(manifest.webapp.executeAs, "USER_ACCESSING");
  assert.equal(manifest.webapp.access, "DOMAIN");
  assert.equal(manifest.oauthScopes.includes("https://www.googleapis.com/auth/gmail.compose"), true);
  assert.equal(manifest.oauthScopes.includes("https://www.googleapis.com/auth/gmail.readonly"), true);
  assert.equal(manifest.oauthScopes.includes("https://www.googleapis.com/auth/spreadsheets"), true);
  assert.equal(manifest.oauthScopes.includes("https://mail.google.com/"), false);
  const page = fs.readFileSync(path.join(__dirname, "../auto-email.html"), "utf8");
  const bridgePage = fs.readFileSync(path.join(__dirname, "../auto-email-bridge.html"), "utf8");
  assert.match(page, /var WEB_APP_URL = "";/);
  assert.match(page, /Would create a Gmail draft in the signed-in clicker's account, not sent\./);
  assert.equal(forbidden.test(page + bridgePage), false);
});
