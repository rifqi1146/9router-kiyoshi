"use client";

import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from "./config";

let translationMap = {};
let currentLocale = DEFAULT_LOCALE;
let reloadCallbacks = [];
let domObserver = null;
let domTranslated = false;
let pendingNodes = new Set();
let pendingTextNodes = new Set();
let flushRafId = null;
// Read locale from cookie
function getLocaleFromCookie() {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : DEFAULT_LOCALE;
  return normalizeLocale(value);
}

// Load translation map
async function loadTranslations(locale) {
  if (locale === "en") {
    translationMap = {};
    return;
  }
  
  try {
    const response = await fetch(`/i18n/literals/${locale}.json`);
    translationMap = await response.json();
  } catch (err) {
    console.error("Failed to load translations:", err);
    translationMap = {};
  }
}

// Translate text - exported for use in components.
//
// `params` fills `{name}` placeholders in the translated string, so a sentence
// with a value inside it stays one dictionary key instead of being split into
// fragments the runtime can never match:
//   translate("Deleted {name}.", { name: "nyx" })
//
// Leading/trailing whitespace is preserved on purpose: JSX routinely renders a
// sentence across several text nodes (`... expires after {n} days.`), and
// dropping the surrounding spaces would jam the fragments together.
export function translate(text, params) {
  if (!text || typeof text !== "string") return text;
  const parts = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!parts) return text;
  const [, lead, core, trail] = parts;
  if (!core) return text;
  let out = currentLocale === "en" ? core : translationMap[core];
  if (out == null) return text;
  if (params && typeof params === "object") {
    out = out.replace(/\{(\w+)\}/g, (whole, key) =>
      Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole,
    );
  }
  return lead + out + trail;
}

// Get current locale - exported for use in components
export function getCurrentLocale() {
  return currentLocale;
}

// Register callback for locale changes
export function onLocaleChange(callback) {
  reloadCallbacks.push(callback);
  return () => {
    reloadCallbacks = reloadCallbacks.filter(cb => cb !== callback);
  };
}

// Process text node
function processTextNode(node) {
  const current = node.nodeValue;
  if (!current || !current.trim()) return;

  // Skip if parent is script, style, code, or structural elements
  const parent = node.parentElement;
  if (!parent) return;

  // Skip if parent or any ancestor has data-i18n-skip attribute
  let element = parent;
  while (element) {
    if (element.hasAttribute && element.hasAttribute('data-i18n-skip')) {
      return;
    }
    element = element.parentElement;
  }

  const tagName = parent.tagName?.toLowerCase();

  // Skip elements that don't allow text nodes
  const skipTags = [
    "script", "style", "code", "pre",
    "colgroup", "table", "thead", "tbody", "tfoot", "tr",
    "select", "datalist", "optgroup"
  ];

  if (skipTags.includes(tagName)) return;

  // React reuses text nodes and rewrites their value on re-render (a
  // characterData mutation, no childList event). When the current value is
  // neither our last translation nor the recorded original, it is fresh
  // source text — re-capture it as the new original before translating.
  const isOurTranslation = node._translated != null && current === node._translated;
  const isSameAsOriginal = current === node._originalText;
  if (!isOurTranslation && !isSameAsOriginal) {
    node._originalText = current;
  }
  if (node._originalText == null) node._originalText = current;

  // Translate from the recorded original so locale switches stay idempotent
  const translated = translate(node._originalText);
  node._translated = translated;

  // Only update if different to avoid unnecessary DOM mutations
  if (translated !== node.nodeValue) {
    node.nodeValue = translated;
  }
}

 // Attributes that carry user-facing copy and should follow the locale.
 // These are NOT text nodes, so the DOM walker above misses them; translate
 // them here (idempotent via the same "translate from original" invariant).
 const TRANSLATABLE_ATTRS = ["placeholder", "title", "aria-label", "alt"];

 function processAttribute(el, attr) {
   const original = el.getAttribute(attr);
   if (!original || !original.trim()) return;
   // Skip if an ancestor marks the whole subtree as skip
   let element = el;
   while (element) {
     if (element.hasAttribute && element.hasAttribute("data-i18n-skip")) return;
     element = element.parentElement;
   }
   const record = el._attrOriginals || (el._attrOriginals = {});
   if (record[attr] == null) record[attr] = original; // first capture
   const translated = translate(record[attr]);
   el._attrTranslated = el._attrTranslated || {};
   if (translated !== el._attrTranslated[attr]) {
     el._attrTranslated[attr] = translated;
     if (translated !== original) el.setAttribute(attr, translated);
   }
 }

 // Process all text nodes in element
 function processElement(element) {
   if (!element) return;

   const walker = document.createTreeWalker(
     element,
     NodeFilter.SHOW_TEXT,
     null,
     false
   );

   let node;
   const nodesToProcess = [];

   // Collect all nodes first to avoid live collection issues
   while ((node = walker.nextNode())) {
     nodesToProcess.push(node);
   }

   // Process collected nodes
   nodesToProcess.forEach(processTextNode);

   // Translate user-facing attributes (placeholder/title/aria-label/alt)
   const elementWalker = document.createTreeWalker(
     element,
     NodeFilter.SHOW_ELEMENT,
     null,
     false
   );
   let el;
   const elementsToProcess = [];
   while ((el = elementWalker.nextNode())) elementsToProcess.push(el);
   elementsToProcess.forEach((e) => TRANSLATABLE_ATTRS.forEach((a) => processAttribute(e, a)));
 }

function shouldSkipNode(node) {
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (!el) return true;
  if (el.closest?.("[data-i18n-skip], svg, code, pre, script, style, .material-symbols-outlined")) {
    return true;
  }
  return false;
}

function scheduleFlush() {
  if (flushRafId !== null) return;
  flushRafId = requestAnimationFrame(() => {
    flushRafId = null;
    const nodes = Array.from(pendingNodes);
    const textNodes = Array.from(pendingTextNodes);
    pendingNodes.clear();
    pendingTextNodes.clear();
    for (const node of nodes) {
      if (node.isConnected && !shouldSkipNode(node)) processElement(node);
    }
    for (const tNode of textNodes) {
      if (tNode.isConnected && !shouldSkipNode(tNode)) processTextNode(tNode);
    }
  });
}

function ensureObserver() {
  if (domObserver || typeof MutationObserver === "undefined" || !document.body) return;
  domObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        if (!shouldSkipNode(mutation.target)) pendingTextNodes.add(mutation.target);
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (!shouldSkipNode(node)) pendingNodes.add(node);
        } else if (node.nodeType === Node.TEXT_NODE) {
          if (!shouldSkipNode(node)) pendingTextNodes.add(node);
        }
      }
    }
    if (pendingNodes.size > 0 || pendingTextNodes.size > 0) {
      scheduleFlush();
    }
  });
  domObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

// Initialize runtime i18n
export async function initRuntimeI18n() {
  if (typeof window === "undefined") return;

  currentLocale = getLocaleFromCookie();
  if (currentLocale === "en") {
    translationMap = {};
    return;
  }

  await loadTranslations(currentLocale);
  domTranslated = true;
  processElement(document.body);
  ensureObserver();
}

// Reload translations when locale changes
export async function reloadTranslations() {
  currentLocale = getLocaleFromCookie();
  if (currentLocale === "en") {
    translationMap = {};
    reloadCallbacks.forEach((callback) => callback());
    if (domTranslated) {
      processElement(document.body);
      domTranslated = false;
    }
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    return;
  }

  await loadTranslations(currentLocale);
  domTranslated = true;
  reloadCallbacks.forEach((callback) => callback());
  processElement(document.body);
  ensureObserver();
}
