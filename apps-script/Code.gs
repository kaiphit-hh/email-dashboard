/**
 * Auto Email web app.
 * Execute as: User accessing the web app.
 * Access: anyone in the company Google Workspace domain.
 *
 * Creates a Gmail DRAFT reply in the clicker's own mailbox.
 * Uses the advanced Gmail service so the project can stay on
 * gmail.compose and gmail.readonly. GmailApp would ask for all of Gmail.
 * There is no send path in this project. Do not add one.
 *
 * GitHub Pages cannot call this web app with fetch(): Google answers
 * with a login redirect and does not send CORS headers. auto-email.html
 * opens this script in a popup. The request is a base64url query value
 * because Chrome clears window.name on the cross-origin navigation.
 * Bridge.html runs the call as the user, then postMessage's the result
 * or redirects back to auto-email-bridge.html.
 */

var MAX_RULES = 40;

function doGet(e) {
  var page = e && e.parameter && e.parameter.page;
  if (page && page !== "bridge") {
    return jsonOut_({ ok: false, sent: false, error: "unknown_page" });
  }
  var rawReq = e && e.parameter && e.parameter.req ? String(e.parameter.req) : "";
  if (rawReq.length > 12000) {
    return jsonOut_({ ok: false, sent: false, error: "too_big", message: "คำขอใหญ่เกินกว่าจะส่งผ่านหน้าต่างยืนยัน" });
  }
  var decoded = rawReq ? decodeRequestParam(rawReq) : "";
  var template = HtmlService.createTemplateFromFile("Bridge");
  template.allowedOriginsJson = JSON.stringify(allowedOrigins_());
  template.requestJson = JSON.stringify(decoded).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return template.evaluate()
    .setTitle("Auto Email")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function apiListRules() {
  var email = assertUser_();
  return { ok: true, sent: false, email: email, rules: readRules_() };
}

function apiSaveRules(payload) {
  var email = assertUser_();
  var incoming = payload && payload.rules;
  if (!Array.isArray(incoming)) {
    return { ok: false, sent: false, error: "bad_rules", message: "ไม่พบรายการกฎ" };
  }
  if (incoming.length > MAX_RULES) {
    return { ok: false, sent: false, error: "too_many", message: "บันทึกได้ไม่เกิน " + MAX_RULES + " กฎ" };
  }
  var rules = [];
  for (var i = 0; i < incoming.length; i++) {
    var clean = normalizeStoredRule(incoming[i]);
    if (clean) rules.push(clean);
  }
  writeRules_(rules, email);
  return { ok: true, sent: false, email: email, count: rules.length, rules: rules };
}

function apiDeleteRule(payload) {
  var email = assertUser_();
  var id = payload && String(payload.id || "");
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
    return { ok: false, sent: false, error: "bad_id", message: "รหัสกฎไม่ถูกต้อง" };
  }
  var rules = readRules_().filter(function (rule) { return rule.id !== id; });
  writeRules_(rules, email);
  return { ok: true, sent: false, email: email, rules: rules };
}

/**
 * Match the shared rules, then create a reply DRAFT in the active user's
 * mailbox. Never sends. If no thread is found, nothing is created.
 */
function apiCreateDraft(request) {
  var email = assertUser_();
  request = request || {};
  var originalSubject = clip_(request.originalSubject || request.subject, 300);
  var body = clip_(request.body, 8000);
  var sender = clip_(request.sender, 200);
  var country = String(request.country || "").trim().toUpperCase();
  if (!/^[A-Z]{2,6}$/.test(country)) {
    return { ok: false, sent: false, error: "bad_country", message: "ประเทศไม่ถูกต้อง" };
  }
  var threadId = String(request.threadId || "").trim();
  var messageId = String(request.messageId || "").trim();
  if (threadId && !isGmailId(threadId)) {
    return { ok: false, sent: false, error: "bad_thread", message: "รหัสเธรดไม่ถูกต้อง" };
  }
  if (messageId && !isGmailId(messageId)) {
    return { ok: false, sent: false, error: "bad_message", message: "รหัสข้อความไม่ถูกต้อง" };
  }
  var match = firstMatch({ subject: originalSubject, body: body, country: country }, readRules_());
  if (!match) {
    return { ok: false, sent: false, error: "no_match", message: "ไม่มีกฎที่ใช้กับอีเมลนี้" };
  }
  var lang = resolveLanguage(match.rule, { subject: originalSubject, body: body });
  var adapted = adaptBody_(match.rule, {
    sender: sender,
    subject: originalSubject,
    body: body
  }, lang);
  var message;
  try {
    message = findMessage_({
      threadId: threadId,
      messageId: messageId,
      subject: originalSubject,
      sender: sender
    });
  } catch (err) {
    return { ok: false, sent: false, error: "gmail", message: "อ่านเธรดใน Gmail ไม่สำเร็จ จึงไม่ได้สร้างแบบร่าง และไม่ได้ส่งอีเมล" };
  }
  if (!message || !message.threadId) {
    return {
      ok: false,
      sent: false,
      error: "not_found",
      message: "ไม่พบเธรดนี้ใน Gmail ของคุณ จึงไม่ได้สร้างแบบร่าง และไม่ได้ส่งอีเมล"
    };
  }
  var created;
  try {
    created = Gmail.Users.Drafts.create({
      message: {
        threadId: message.threadId,
        raw: replyRaw_(message, adapted.body, originalSubject, sender)
      }
    }, "me");
  } catch (err) {
    return { ok: false, sent: false, error: "gmail", message: "สร้างแบบร่างไม่สำเร็จ และไม่ได้ส่งอีเมล" };
  }
  var draftMessageId = created && created.message && created.message.id ? String(created.message.id) : "";
  var draftThreadId = created && created.message && created.message.threadId ? String(created.message.threadId) : message.threadId;
  var url = draftMessageId
    ? "https://mail.google.com/mail/u/0/#drafts?compose=" + encodeURIComponent(draftMessageId)
    : "https://mail.google.com/mail/u/0/#drafts";
  return {
    ok: true,
    sent: false,
    mode: "gmail",
    email: email,
    notice: "Created a Gmail draft in the signed-in clicker's account, not sent.",
    draft: {
      id: created && created.id ? String(created.id) : "",
      messageId: draftMessageId,
      threadId: draftThreadId,
      url: url,
      body: adapted.body,
      adapter: adapted.adapter,
      warning: adapted.warning || "",
      language: lang,
      ruleId: match.rule.id,
      ruleName: match.rule.name || match.keyword,
      keyword: match.keyword
    }
  };
}

function assertUser_() {
  var email = "";
  try { email = Session.getActiveUser().getEmail() || ""; } catch (err) { email = ""; }
  email = String(email).trim().toLowerCase();
  var at = email.lastIndexOf("@");
  var domain = at > 0 ? email.slice(at + 1) : "";
  var allowed = allowedDomain_();
  if (!email || !allowed || domain !== allowed) {
    throw new Error("ใช้ได้เฉพาะบัญชี @" + (allowed || "บริษัท"));
  }
  return email;
}

function allowedDomain_() {
  var value = prop_("ALLOWED_DOMAIN") || "hungryhub.com";
  return String(value).trim().toLowerCase().replace(/^@/, "");
}

function allowedOrigins_() {
  return prop_("ALLOWED_ORIGINS").split(",").map(function (s) { return s.trim(); }).filter(function (s) {
    return /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/i.test(s) || /^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/i.test(s);
  });
}

function prop_(key) {
  try {
    return PropertiesService.getScriptProperties().getProperty(key) || "";
  } catch (err) {
    return "";
  }
}

function sheet_() {
  var id = prop_("RULES_SHEET_ID");
  if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) {
    throw new Error("ยังไม่ได้ตั้ง RULES_SHEET_ID");
  }
  var ss = SpreadsheetApp.openById(id);
  var sh = ss.getSheetByName("Rules") || ss.getSheets()[0];
  if (!sh) throw new Error("ไม่พบชีตกฎ");
  return sh;
}

function readRules_() {
  var sh = sheet_();
  var last = sh.getLastRow();
  var width = Math.max(sh.getLastColumn(), RULE_HEADER.length);
  if (last < 1) return [];
  var values = sh.getRange(1, 1, last, width).getValues();
  return rulesFromSheetValues(values);
}

function writeRules_(rules, email) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sh = sheet_();
    var rows = rulesToSheetValues(rules, email, new Date().toISOString());
    sh.clearContents();
    sh.getRange(1, 1, rows.length, RULE_HEADER.length).setValues(rows);
  } finally {
    lock.releaseLock();
  }
}

function gmailGet_(id) {
  try {
    return Gmail.Users.Messages.get("me", id, {
      format: "metadata",
      metadataHeaders: ["From", "Reply-To", "Subject", "Message-ID", "References"]
    });
  } catch (err) {
    return null;
  }
}

function gmailThreadLast_(threadId) {
  try {
    var thread = Gmail.Users.Threads.get("me", threadId, {
      format: "metadata",
      metadataHeaders: ["From", "Reply-To", "Subject", "Message-ID", "References"]
    });
    var messages = thread && thread.messages ? thread.messages : [];
    return messages.length ? messages[messages.length - 1] : null;
  } catch (err) {
    return null;
  }
}

function findMessage_(request) {
  if (request.messageId || request.threadId) {
    if (request.messageId) {
      var byMessage = gmailGet_(request.messageId);
      if (byMessage) return byMessage;
    }
    if (request.threadId) {
      var byThread = gmailThreadLast_(request.threadId);
      if (byThread) return byThread;
    }
    return null;
  }
  var subject = sanitizeSearchTerm(request.subject);
  if (!subject) return null;
  var query = 'newer_than:60d subject:"' + subject + '"';
  var sender = sanitizeSearchTerm(request.sender);
  if (sender) {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) query += " from:" + sender;
    else query += ' "' + sender + '"';
  }
  var listed;
  try {
    listed = Gmail.Users.Messages.list("me", { q: query, maxResults: 5 });
  } catch (err) {
    throw new Error("list_failed");
  }
  var ids = listed && listed.messages ? listed.messages : [];
  if (!ids.length || !ids[0].id) return null;
  return gmailGet_(ids[0].id);
}

function header_(message, name) {
  var headers = message && message.payload && message.payload.headers ? message.payload.headers : [];
  var want = String(name || "").toLowerCase();
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i].name || "").toLowerCase() === want) return String(headers[i].value || "");
  }
  return "";
}

function headerEncode_(value) {
  var text = String(value || "").replace(/[\r\n]+/g, " ").trim();
  if (/^[\t\x20-\x7E]*$/.test(text)) return text;
  return "=?UTF-8?B?" + Utilities.base64Encode(text, Utilities.Charset.UTF_8) + "?=";
}

function replyAddress_(message, fallbackSender) {
  var raw = header_(message, "Reply-To") || header_(message, "From") || fallbackSender || "";
  var wrapped = raw.match(/<([^<>\s]+@[^<>\s]+)>/);
  var addr = wrapped ? wrapped[1] : String(raw).trim();
  if (!/^[^\s<>"]+@[^\s<>"]+\.[^\s<>"]+$/.test(addr)) return "";
  return addr;
}

/** RFC822 reply. Drafts.create stores it; this function does not send. */
function replyRaw_(message, body, fallbackSubject, fallbackSender) {
  var subject = header_(message, "Subject") || fallbackSubject || "";
  if (!/^re\s*:/i.test(subject)) subject = "Re: " + subject;
  var to = replyAddress_(message, fallbackSender);
  var lines = ["Subject: " + headerEncode_(subject)];
  if (to) lines.push("To: " + to);
  var msgId = header_(message, "Message-ID");
  if (msgId) {
    var refs = header_(message, "References");
    lines.push("In-Reply-To: " + msgId.replace(/[\r\n]/g, ""));
    lines.push("References: " + ((refs ? refs + " " : "") + msgId).replace(/[\r\n]/g, " "));
  }
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(Utilities.base64Encode(String(body || ""), Utilities.Charset.UTF_8).replace(/(.{76})/g, "$1\r\n"));
  return Utilities.base64EncodeWebSafe(lines.join("\r\n")).replace(/=+$/, "");
}

function adaptBody_(rule, email, lang) {
  var signature = lang === "EN" ? (prop_("DRAFT_SIGNATURE_EN") || "") : (prop_("DRAFT_SIGNATURE_TH") || "");
  var fallback = templateAdapt(rule, email, lang, signature || undefined);
  if (String(prop_("DRAFT_ADAPTER")).toLowerCase() !== "llm") return fallback;
  try {
    var llm = llmAdapt_(rule, email, lang, fallback.body);
    return llm || fallback;
  } catch (err) {
    fallback.warning = "ใช้ข้อความเทมเพลต เพราะเรียก LLM ไม่สำเร็จ";
    return fallback;
  }
}

/**
 * Optional. Reads LLM_API_KEY from Script Properties. Never hard-codes a key.
 * Falls back to the deterministic template when the key or the request fails.
 */
function llmAdapt_(rule, email, lang, templateBody) {
  var key = prop_("LLM_API_KEY");
  if (!key) {
    var plain = templateAdapt(rule, email, lang);
    plain.warning = "ไม่พบ LLM_API_KEY จึงใช้เทมเพลต";
    return plain;
  }
  var url = prop_("LLM_API_URL") || "https://api.openai.com/v1/chat/completions";
  var model = prop_("LLM_MODEL") || "gpt-4o-mini";
  var languageName = lang === "EN" ? "English" : "Thai";
  var payload = {
    model: model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: "Write only the reply email body in " + languageName + ". Use the template as the facts. Do not invent payment status, dates, or attachments. Do not say the email was sent."
      },
      {
        role: "user",
        content: "Sender: " + clip_(email.sender, 200) +
          "\nSubject: " + clip_(email.subject, 300) +
          "\nIncoming mail:\n" + clip_(email.body, 4000) +
          "\n\nTemplate:\n" + clip_(rule.template, 4000) +
          "\n\nStarting point:\n" + clip_(templateBody, 4000)
      }
    ]
  };
  var response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + key },
    muteHttpExceptions: true,
    payload: JSON.stringify(payload)
  });
  var code = response.getResponseCode();
  var parsed = {};
  try { parsed = JSON.parse(response.getContentText() || "{}"); } catch (err) { parsed = {}; }
  var text = "";
  if (parsed.choices && parsed.choices[0] && parsed.choices[0].message) text = parsed.choices[0].message.content || "";
  if (!text && parsed.text) text = String(parsed.text);
  text = String(text || "").trim();
  if (code < 200 || code >= 300 || !text) {
    var again = templateAdapt(rule, email, lang);
    again.warning = "ใช้ข้อความเทมเพลต เพราะ LLM ตอบกลับไม่สำเร็จ";
    return again;
  }
  return { adapter: "llm", body: text.slice(0, 8000) + "\n", warning: "" };
}

function clip_(value, max) {
  return String(value == null ? "" : value).slice(0, max);
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
