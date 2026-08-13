import { canonicalizeJson, deepFreeze, sha256Hex } from "./growth/canonical.mjs";
import { containsCredential } from "./security/credential-patterns.mjs";

const INGRESS = "local_owner_app";
const COUPANG_ORIGINS = new Set(["https://www.coupang.com", "https://m.coupang.com"]);
const BLOCKED_ACTIONS = new Set([
  "browser.raw",
  "browser.evaluate",
  "browser.cookies",
  "browser.storage",
  "browser.request-body",
  "browser.response-body",
  "browser.upload",
  "browser.download",
  "coupang.checkout",
  "coupang.order",
  "coupang.purchase",
  "payment.submit",
  "mail.send",
  "mail.reply",
  "mail.forward",
  "mail.delete",
  "mail.archive",
  "mail.mark-read",
]);

function taskError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode });
}

function plainObject(value, code = "invalid_web_task_parameters") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw taskError(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw taskError(code);
  return value;
}

function exactKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw taskError("unknown_web_task_parameter");
  }
}

function boundedText(value, code, maximum) {
  if (typeof value !== "string") throw taskError(code);
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) throw taskError(code);
  return normalized;
}

function credentialFreePublicText(value, code, maximum) {
  const normalized = boundedText(value, code, maximum);
  if (containsCredential(normalized, { includeLooseAssignments: true })) {
    throw taskError("credential_in_web_task", 403);
  }
  return normalized;
}

function integer(value, code, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw taskError(code);
  return value;
}

function normalizeCoupangProductUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw taskError("invalid_coupang_product_url");
  }
  if (!COUPANG_ORIGINS.has(url.origin) || !/^\/vp\/products\/[1-9][0-9]{0,19}$/.test(url.pathname)) {
    throw taskError("invalid_coupang_product_url");
  }
  if (url.username || url.password || url.hash) throw taskError("invalid_coupang_product_url");
  const allowedQuery = new Set(["itemId", "vendorItemId"]);
  for (const key of url.searchParams.keys()) {
    if (!allowedQuery.has(key)) throw taskError("invalid_coupang_product_url");
  }
  for (const key of allowedQuery) {
    const entry = url.searchParams.get(key);
    if (entry !== null && !/^[1-9][0-9]{0,19}$/.test(entry)) throw taskError("invalid_coupang_product_url");
  }
  url.protocol = "https:";
  url.hostname = "www.coupang.com";
  url.port = "";
  return url.toString();
}

function coupangSearch(parameters) {
  exactKeys(parameters, new Set(["query"]));
  return {
    risk: "read_public_catalog",
    requiresApproval: false,
    dataCategories: ["shopping_query"],
    parameters: { query: credentialFreePublicText(parameters.query, "invalid_coupang_query", 120) },
  };
}

function coupangCartAdd(parameters) {
  exactKeys(parameters, new Set([
    "productUrl", "productName", "option", "quantity", "expectedUnitPrice", "maxTotalPrice", "currency",
  ]));
  const quantity = integer(parameters.quantity, "invalid_coupang_quantity", 1, 20);
  const expectedUnitPrice = integer(parameters.expectedUnitPrice, "invalid_coupang_price", 1, 100_000_000);
  const maxTotalPrice = integer(parameters.maxTotalPrice, "invalid_coupang_max_total", expectedUnitPrice * quantity, 500_000_000);
  if (parameters.currency !== "KRW") throw taskError("invalid_coupang_currency");
  return {
    risk: "authenticated_account_mutation",
    requiresApproval: true,
    dataCategories: ["shopping", "account_action"],
    parameters: {
      productUrl: normalizeCoupangProductUrl(parameters.productUrl),
      productName: credentialFreePublicText(parameters.productName, "invalid_coupang_product_name", 200),
      option: parameters.option === null
        ? null
        : credentialFreePublicText(parameters.option, "invalid_coupang_option", 160),
      quantity,
      expectedUnitPrice,
      maxTotalPrice,
      currency: "KRW",
    },
  };
}

function importantMail(parameters) {
  exactKeys(parameters, new Set(["provider", "maxResults", "unreadOnly"]));
  if (parameters.provider !== "gmail") throw taskError("unsupported_mail_provider");
  if (typeof parameters.unreadOnly !== "boolean") throw taskError("invalid_mail_filter");
  return {
    risk: "private_read",
    requiresApproval: false,
    dataCategories: ["private_mail"],
    parameters: {
      provider: "gmail",
      maxResults: integer(parameters.maxResults, "invalid_mail_limit", 1, 20),
      unreadOnly: parameters.unreadOnly,
    },
  };
}

function readMail(parameters) {
  exactKeys(parameters, new Set(["provider", "selectionId"]));
  if (parameters.provider !== "gmail") throw taskError("unsupported_mail_provider");
  const selectionId = boundedText(parameters.selectionId, "invalid_mail_selection", 128);
  if (!/^[A-Za-z0-9_-]+$/.test(selectionId)) throw taskError("invalid_mail_selection");
  return {
    risk: "private_read",
    requiresApproval: false,
    dataCategories: ["private_mail"],
    parameters: { provider: "gmail", selectionId },
  };
}

const VALIDATORS = new Map([
  ["coupang.search", coupangSearch],
  ["coupang.cart.add", coupangCartAdd],
  ["mail.important.list", importantMail],
  ["mail.message.read", readMail],
]);

export function validateWebTask(value) {
  const task = plainObject(value, "invalid_web_task");
  exactKeys(task, new Set(["ingress", "action", "parameters"]));
  if (task.ingress !== INGRESS) throw taskError("local_owner_app_required", 403);
  if (typeof task.action !== "string") throw taskError("invalid_web_task_action");
  if (BLOCKED_ACTIONS.has(task.action)) throw taskError("web_task_action_blocked", 403);
  const validator = VALIDATORS.get(task.action);
  if (!validator) throw taskError("unsupported_web_task_action", 403);
  const normalized = validator(plainObject(task.parameters));
  const plan = {
    schema: "local-ai.web-task-plan.v1",
    ingress: INGRESS,
    action: task.action,
    risk: normalized.risk,
    requiresApproval: normalized.requiresApproval,
    dataCategories: normalized.dataCategories,
    parameters: normalized.parameters,
    restrictions: {
      browserProfile: "shared_chrome_tabs",
      localModelOnly: true,
      rawBrowserToolsExposedToModel: false,
      returnChannel: "local_owner_app_only",
    },
  };
  const canonical = canonicalizeJson(plan);
  return deepFreeze({ ...plan, canonical, sha256: sha256Hex(canonical) });
}

export function isBlockedWebTaskAction(action) {
  return BLOCKED_ACTIONS.has(action);
}

export const WEB_TASK_ACTIONS = Object.freeze([...VALIDATORS.keys()]);
