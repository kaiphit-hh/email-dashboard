/**
 * Pure rule matching and draft-text helpers.
 * Used by Apps Script (global functions) and by node tests (module.exports).
 * Matching is a literal substring: not a regex, not case-folded.
 * A row matches only when an enabled rule's country list includes the email
 * country and the subject or body contains a keyword exactly as written.
 */

var RULE_HEADER = ["id", "name", "enabled", "keywords", "template", "countries", "language", "updatedBy", "updatedAt"];

function splitKeywords(text) {
  return String(text || "").split(/\r?\n/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
}

function keywordHit(rule, email) {
  if (!rule || !rule.enabled) return "";
  if (!email || !rule.countries || rule.countries.indexOf(email.country) < 0) return "";
  var hay = (email.subject || "") + "\n" + (email.body || "");
  var keys = splitKeywords(rule.keywords);
  for (var i = 0; i < keys.length; i++) {
    if (hay.indexOf(keys[i]) !== -1) return keys[i];
  }
  return "";
}

function firstMatch(email, rules) {
  var list = rules || [];
  for (var i = 0; i < list.length; i++) {
    var hit = keywordHit(list[i], email);
    if (hit) return { rule: list[i], index: i, keyword: hit };
  }
  return null;
}

function hasThai(text) {
  return /[\u0E00-\u0E7F]/.test(text || "");
}

function resolveLanguage(rule, email) {
  if (!rule) return "TH";
  if (rule.language === "en") return "EN";
  if (rule.language === "th") return "TH";
  var hay = (email && email.subject ? email.subject : "") + "\n" + (email && email.body ? email.body : "");
  return hasThai(hay) ? "TH" : "EN";
}

function normalizeStoredRule(rule) {
  if (!rule || typeof rule !== "object") return null;
  var id = String(rule.id || "").trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null;
  var lang = rule.language === "en" || rule.language === "match" ? rule.language : "th";
  var seen = {};
  var countries = [];
  var rawCountries = Array.isArray(rule.countries) ? rule.countries : String(rule.countries || "").split(/[,|\n]/);
  rawCountries.forEach(function (c) {
    var code = String(c || "").trim().toUpperCase();
    if (!/^[A-Z]{2,6}$/.test(code) || seen[code]) return;
    seen[code] = true;
    countries.push(code);
  });
  var flag = String(rule.enabled == null ? "" : rule.enabled).trim().toLowerCase();
  var enabled = rule.enabled !== false && flag !== "false" && flag !== "0" && flag !== "no";
  return {
    id: id,
    name: String(rule.name || "").slice(0, 80),
    enabled: enabled,
    keywords: String(rule.keywords == null ? "" : rule.keywords).slice(0, 4000),
    template: String(rule.template == null ? "" : rule.template).slice(0, 8000),
    countries: countries,
    language: lang
  };
}

function rulesFromSheetValues(values) {
  if (!values || !values.length) return [];
  var header = (values[0] || []).map(function (h) { return String(h || "").trim(); });
  var idx = {};
  header.forEach(function (h, i) { if (h) idx[h] = i; });
  if (idx.id == null) return [];
  function sheetCell(row, name) {
    if (idx[name] == null) return "";
    var v = row[idx[name]];
    return v == null ? "" : String(v);
  }
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r] || [];
    if (!String(sheetCell(row, "id")).trim()) continue;
    var countries = sheetCell(row, "countries").split(/[,|\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
    out.push(normalizeStoredRule({
      id: sheetCell(row, "id"),
      name: sheetCell(row, "name"),
      enabled: sheetCell(row, "enabled"),
      keywords: sheetCell(row, "keywords"),
      template: sheetCell(row, "template"),
      countries: countries,
      language: sheetCell(row, "language")
    }));
  }
  return out.filter(Boolean);
}

function rulesToSheetValues(rules, updatedBy, updatedAt) {
  var rows = [RULE_HEADER.slice()];
  (rules || []).forEach(function (rule) {
    var clean = normalizeStoredRule(rule);
    if (!clean) return;
    rows.push([
      clean.id,
      clean.name,
      clean.enabled ? "TRUE" : "FALSE",
      clean.keywords,
      clean.template,
      clean.countries.join(","),
      clean.language,
      String(updatedBy || "").slice(0, 120),
      String(updatedAt || "")
    ]);
  });
  return rows;
}

function senderName(sender) {
  var s = String(sender || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.slice(0, 80);
}

function stripGenericGreeting(template) {
  return String(template || "")
    .replace(/^\s*เรียน\s+คุณลูกค้า\s*/i, "")
    .replace(/^\s*dear\s+(customer|sir|madam|team)\s*,?\s*/i, "")
    .trim();
}

/**
 * Deterministic draft body: greeting with the sender's name, the template
 * (generic greeting removed), the original subject, and a signature.
 * This does not call a network and does not send mail.
 */
function templateAdapt(rule, email, lang, signature) {
  var name = senderName(email && email.sender) || (lang === "EN" ? "Customer" : "คุณลูกค้า");
  var greeting = lang === "EN" ? "Dear " + name + "," : "เรียน " + name;
  var subject = email && email.subject ? String(email.subject) : "";
  var subjectLine = lang === "EN" ? "Regarding: " + subject : "เรื่อง: " + subject;
  var sig = signature || (lang === "EN" ? "Hungry Hub Accounting" : "ทีมบัญชี Hungry Hub");
  var substance = stripGenericGreeting(rule && rule.template);
  return {
    adapter: "template",
    body: [greeting, "", substance, "", subjectLine, "", sig].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"
  };
}

/** Remove Gmail search operators so a subject cannot change the query shape. */
function sanitizeSearchTerm(value) {
  return String(value || "")
    .replace(/["\\\r\n]/g, " ")
    .replace(/\b(from|to|subject|label|in|is|has|newer_than|older_than|filename|category|rfc822msgid):/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function isGmailId(value) {
  return /^[a-fA-F0-9]{10,32}$/.test(String(value || ""));
}

/**
 * base64url JSON, used because Chrome clears window.name on the way to
 * script.google.com. Returns "" when the text is not valid UTF-8 JSON input.
 */
function decodeRequestParam(b64) {
  var s = String(b64 || "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*$/.test(s)) return "";
  while (s.length % 4) s += "=";
  var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var bytes = [];
  for (var i = 0; i < s.length; i += 4) {
    var n = [0, 1, 2, 3].map(function (k) { return alphabet.indexOf(s.charAt(i + k)); });
    if (n[0] < 0 || n[1] < 0) return "";
    bytes.push((n[0] << 2) | (n[1] >> 4));
    if (s.charAt(i + 2) !== "=" && n[2] >= 0) bytes.push(((n[1] & 15) << 4) | (n[2] >> 2));
    if (s.charAt(i + 3) !== "=" && n[3] >= 0) bytes.push(((n[2] & 3) << 6) | n[3]);
  }
  var out = "";
  for (var b = 0; b < bytes.length; ) {
    var c = bytes[b];
    if (c < 128) { out += String.fromCharCode(c); b += 1; }
    else if (c >= 192 && c < 224 && b + 1 < bytes.length) {
      out += String.fromCharCode(((c & 31) << 6) | (bytes[b + 1] & 63));
      b += 2;
    } else if (c >= 224 && c < 240 && b + 2 < bytes.length) {
      out += String.fromCharCode(((c & 15) << 12) | ((bytes[b + 1] & 63) << 6) | (bytes[b + 2] & 63));
      b += 3;
    } else return "";
  }
  return out;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    RULE_HEADER: RULE_HEADER,
    splitKeywords: splitKeywords,
    keywordHit: keywordHit,
    firstMatch: firstMatch,
    resolveLanguage: resolveLanguage,
    normalizeStoredRule: normalizeStoredRule,
    rulesFromSheetValues: rulesFromSheetValues,
    rulesToSheetValues: rulesToSheetValues,
    senderName: senderName,
    stripGenericGreeting: stripGenericGreeting,
    templateAdapt: templateAdapt,
    sanitizeSearchTerm: sanitizeSearchTerm,
    isGmailId: isGmailId,
    decodeRequestParam: decodeRequestParam
  };
}
