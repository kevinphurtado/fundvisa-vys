// FUNDVISA - Utils (sanitize/validate/ui)
// Usar como ES Module: import { ... } from "./utils.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function cleanText(str, { max = 5000, allowNewlines = true } = {}) {
  const s = String(str ?? "")
    .replace(/\u0000/g, "")
    .replace(/[^\S\r\n]+/g, " ") // colapsa espacios
    .trim();

  // Bloqueo básico de tags (defensa adicional a reglas)
  const noTags = s.replace(/[<>]/g, "");
  const normalized = allowNewlines ? noTags : noTags.replace(/[\r\n]+/g, " ");

  return normalized.slice(0, max);
}

export function cleanEmail(email, { max = 120 } = {}) {
  const e = String(email ?? "").trim().toLowerCase().slice(0, max);
  // RFC-lite: suficiente para formularios web
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
  return ok ? e : "";
}

export function cleanPhone(phone, { max = 20 } = {}) {
  const p = String(phone ?? "")
    .replace(/[^\d+]/g, "")
    .slice(0, max);
  // mínimo 7 dígitos
  const digits = p.replace(/\D/g, "");
  return digits.length >= 7 ? p : "";
}

export function cleanUrl(url, { max = 500 } = {}) {
  const u = String(url ?? "").trim().slice(0, max);
  if (!u) return "";
  try {
    const parsed = new URL(u, window.location.origin);
    // solo http/https
    if (!/^https?:$/.test(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

export function clampInt(v, { min = 0, max = 999999, fallback = 0 } = {}) {
  const n = Number.parseInt(v, 10);
  if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
  return fallback;
}

export function clampFloat(v, { min = 0, max = 999999, fallback = 0 } = {}) {
  const n = Number.parseFloat(v);
  if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
  return fallback;
}

export function uid(prefix = "id") {
  return `${prefix}_${crypto.getRandomValues(new Uint32Array(4)).join("")}_${Date.now()}`;
}

export function bytesToMB(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

// --- UI: Toast (Bootstrap 5) ---
export function toast(message, type = "info", { title = "FUNDVISA", delay = 3500 } = {}) {
  // type: info | success | warning | danger
  const wrapId = "fv-toast-wrap";
  let wrap = document.getElementById(wrapId);
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = wrapId;
    wrap.className = "toast-container position-fixed top-0 end-0 p-3";
    wrap.style.zIndex = "2000";
    document.body.appendChild(wrap);
  }

  const el = document.createElement("div");
  el.className = `toast align-items-center text-bg-${type} border-0`;
  el.setAttribute("role", "alert");
  el.setAttribute("aria-live", "assertive");
  el.setAttribute("aria-atomic", "true");
  el.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">
        <strong class="me-2">${escapeHtml(title)}:</strong>
        <span>${escapeHtml(message)}</span>
      </div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Cerrar"></button>
    </div>
  `;
  wrap.appendChild(el);

  // Bootstrap global
  const t = window.bootstrap?.Toast ? new window.bootstrap.Toast(el, { delay }) : null;
  t?.show();

  el.addEventListener("hidden.bs.toast", () => el.remove(), { once: true });
}

// --- Excel export (SheetJS) ---
export function exportToXlsx(rows, filename = "export.xlsx", sheetName = "Datos") {
  if (!Array.isArray(rows) || !rows.length) {
    toast("No hay datos para exportar.", "warning");
    return;
  }
  if (!window.XLSX) {
    toast("Falta la librería XLSX (SheetJS). Revisa el script en admin.html.", "danger");
    return;
  }

  const ws = window.XLSX.utils.json_to_sheet(rows);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  window.XLSX.writeFile(wb, filename);
}

// --- Time formatting ---
export function fmtDate(ts) {
  try {
    const d = ts?.toDate ? ts.toDate() : (ts instanceof Date ? ts : (ts ? new Date(ts) : null));
    if (!d || Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("es-CO");
  } catch {
    return "";
  }
}
